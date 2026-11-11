// 本机持久化（IndexedDB）：消息、对话元数据、没发完的消息、媒体文件。
// 只在这台设备上；IndexedDB 不可用（隐私模式、被禁用）时退回内存，App 照常用，只是关掉就没了。

const DB_NAME = 'chat-app';
const DB_VERSION = 1;
const MEDIA_KEEP = 300;

const done = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});
const finished = tx => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
});

function memoryDb() {
    const messages = new Map();
    const pending = new Map();
    const blobs = new Map();
    let meta;
    return {
        persistent: false,
        async loadInitial(limit) {
            const all = [...messages.values()].sort((a, b) => a.seq - b.seq);
            return { meta, messages: all.slice(-limit), pending: [...pending.values()] };
        },
        async putMessages(list) { for (const message of list) messages.set(message.seq, message); },
        async messagesBefore(seq, limit) { return [...messages.values()].filter(m => m.seq < seq).sort((a, b) => a.seq - b.seq).slice(-limit); },
        async deleteMessagesBefore(seq) { for (const key of [...messages.keys()]) if (key < seq) messages.delete(key); },
        async saveMeta(value) { meta = value; },
        async putPending(item) { pending.set(item.clientId, item); },
        async deletePending(clientId) { pending.delete(clientId); },
        async getBlob(key) { return blobs.get(key); },
        async putBlob(key, blob) { blobs.set(key, blob); },
        async deleteBlob(key) { blobs.delete(key); },
        async clear() { messages.clear(); pending.clear(); blobs.clear(); meta = undefined; },
    };
}

export async function openDb() {
    let db;
    try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const upgrade = request.result;
            if (!upgrade.objectStoreNames.contains('messages')) upgrade.createObjectStore('messages', { keyPath: 'seq' });
            if (!upgrade.objectStoreNames.contains('pending')) upgrade.createObjectStore('pending', { keyPath: 'clientId' });
            if (!upgrade.objectStoreNames.contains('meta')) upgrade.createObjectStore('meta');
            if (!upgrade.objectStoreNames.contains('media')) upgrade.createObjectStore('media', { keyPath: 'key' }).createIndex('at', 'at');
        };
        db = await done(request);
    } catch {
        return memoryDb();
    }
    db.onversionchange = () => db.close();

    /** 从后往前读 limit 条，返回升序 */
    const tail = (range, limit) => new Promise((resolve, reject) => {
        const out = [];
        const request = db.transaction('messages').objectStore('messages').openCursor(range, 'prev');
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || out.length >= limit) return resolve(out.reverse());
            out.push(cursor.value);
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });

    const pruneMedia = async () => {
        const tx = db.transaction('media', 'readwrite');
        const store = tx.objectStore('media');
        const count = await done(store.count());
        let extra = count - MEDIA_KEEP;
        if (extra > 0) {
            await new Promise((resolve, reject) => {
                const request = store.index('at').openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor || extra <= 0) return resolve(undefined);
                    // 还没传完的本地文件不能清
                    if (!String(cursor.value.key).startsWith('local:')) { cursor.delete(); extra--; }
                    cursor.continue();
                };
                request.onerror = () => reject(request.error);
            });
        }
        await finished(tx).catch(() => {});
    };
    let mediaWrites = 0;

    return {
        persistent: true,
        async loadInitial(limit) {
            const [meta, messages, pending] = await Promise.all([
                done(db.transaction('meta').objectStore('meta').get('state')),
                tail(undefined, limit),
                done(db.transaction('pending').objectStore('pending').getAll()),
            ]);
            return { meta, messages, pending: pending.sort((a, b) => a.at - b.at) };
        },
        async putMessages(list) {
            if (!list.length) return;
            const tx = db.transaction('messages', 'readwrite');
            const store = tx.objectStore('messages');
            for (const message of list) store.put(message);
            await finished(tx);
        },
        messagesBefore(seq, limit) {
            return tail(IDBKeyRange.upperBound(seq, true), limit);
        },
        async deleteMessagesBefore(seq) {
            const tx = db.transaction('messages', 'readwrite');
            tx.objectStore('messages').delete(IDBKeyRange.upperBound(seq, true));
            await finished(tx);
        },
        async saveMeta(meta) {
            const tx = db.transaction('meta', 'readwrite');
            tx.objectStore('meta').put(meta, 'state');
            await finished(tx);
        },
        async putPending(item) {
            const tx = db.transaction('pending', 'readwrite');
            tx.objectStore('pending').put(item);
            await finished(tx);
        },
        async deletePending(clientId) {
            const tx = db.transaction('pending', 'readwrite');
            tx.objectStore('pending').delete(clientId);
            await finished(tx);
        },
        async getBlob(key) {
            const record = await done(db.transaction('media').objectStore('media').get(key));
            return record?.blob;
        },
        async putBlob(key, blob) {
            const tx = db.transaction('media', 'readwrite');
            tx.objectStore('media').put({ key, blob, at: Date.now() });
            await finished(tx);
            if (++mediaWrites % 20 === 0) void pruneMedia();
        },
        async deleteBlob(key) {
            const tx = db.transaction('media', 'readwrite');
            tx.objectStore('media').delete(key);
            await finished(tx);
        },
        async clear() {
            const tx = db.transaction(['messages', 'pending', 'meta', 'media'], 'readwrite');
            for (const name of ['messages', 'pending', 'meta', 'media']) tx.objectStore(name).clear();
            await finished(tx);
        },
    };
}
