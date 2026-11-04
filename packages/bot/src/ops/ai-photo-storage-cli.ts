// AI 照片草稿存储只读审计（ADR 0246）。没有 --apply，也不会删除文件。

import { resolve } from 'node:path';
import { auditAiPhotoStorage } from '../vision/ai-photo-storage.ts';

const input = process.argv[2];
if (!input) {
    console.error('用法：npm --workspace @qqbot/bot run ai-photo:audit -- <ai-photo-drafts 目录>');
    process.exit(2);
}

const report = auditAiPhotoStorage(resolve(process.env.INIT_CWD ?? process.cwd(), input));
console.log(`AI 照片草稿：索引 ${report.entries} 条，文件 ${report.files} 个，问题 ${report.issues.length} 个`);
const issueNames: Record<(typeof report.issues)[number]['code'], string> = {
    index_invalid: '索引结构无效', index_symlink: '索引是符号链接', files_not_directory: '图片目录无效', files_symlink: '图片目录是符号链接',
    entry_file_invalid: '索引中的文件名或编号不匹配', entry_file_missing: '索引对应的图片缺失', entry_file_symlink: '索引图片是符号链接',
    entry_file_not_regular: '索引图片不是普通文件', orphan_file: '存在孤立图片', unexpected_file: '存在未知文件',
};
for (const [code, count] of Object.entries(Object.groupBy(report.issues, issue => issue.code)).map(([code, values]) => [code, values?.length ?? 0])) {
    console.log(`- ${issueNames[code as keyof typeof issueNames]}：${count}`);
}
console.log(`清理预览：${report.cleanup.length} 项（只读演练，没有执行删除）`);
for (const item of report.cleanup) console.log(`- ${item.kind} ${item.id} ${item.file}`);
process.exitCode = report.issues.length ? 1 : 0;

