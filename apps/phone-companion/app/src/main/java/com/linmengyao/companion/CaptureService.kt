package com.linmengyao.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 每隔 N 秒截一张屏幕，压成 720p 的 JPEG 推到设备取件中心的 /frame。
 * 只做这一件事：不读通知、不读文件、不攒历史；推不上去就丢这一帧。
 */
class CaptureService : Service() {

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var hub = ""
    private var token = ""
    private var intervalMs = 60_000L
    /** 上一帧是什么时候推的：屏幕一直在变时 setOnImageAvailable 会一直触发，必须自己节流 */
    private var lastSentAt = 0L
    private val handler = Handler(HandlerThread("capture").apply { start() }.looper)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY
        hub = intent.getStringExtra(MainActivity.EXTRA_HUB).orEmpty().trimEnd('/')
        token = intent.getStringExtra(MainActivity.EXTRA_TOKEN).orEmpty()
        intervalMs = intent.getIntExtra(MainActivity.EXTRA_INTERVAL, 60).coerceAtLeast(5) * 1000L
        if (hub.isEmpty() || token.isEmpty()) { stopSelf(); return START_NOT_STICKY }
        startForeground(NOTIFICATION_ID, notification())

        val manager = getSystemService(MediaProjectionManager::class.java)
        val data: Intent = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(MainActivity.EXTRA_RESULT_DATA, Intent::class.java)!! else @Suppress("DEPRECATION") intent.getParcelableExtra(MainActivity.EXTRA_RESULT_DATA)!!
        projection = manager.getMediaProjection(intent.getIntExtra(MainActivity.EXTRA_RESULT_CODE, 0), data)
        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { release(); stopSelf() }
        }, handler)

        val metrics = resources.displayMetrics
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        display = projection?.createVirtualDisplay("companion", width, height, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader?.surface, null, handler)

        reader?.setOnImageAvailableListener({ r -> grabAndSend(r) }, handler)
        return START_STICKY
    }

    private fun grabAndSend(reader: ImageReader) {
        val image = try { reader.acquireLatestImage() } catch (error: Exception) { null } ?: return
        val now = System.currentTimeMillis()
        if (now - lastSentAt < intervalMs) { image.close(); return }
        lastSentAt = now
        try {
            val bitmap = toBitmap(image)
            val scaled = scale(bitmap)
            val jpeg = ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, 60, it) }.toByteArray()
            post(jpeg)
        } catch (error: Exception) {
            Log.w(TAG, "截图没发出去：${error.message}")
        } finally {
            image.close()
        }
    }

    private fun toBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * image.width
        val bitmap = Bitmap.createBitmap(image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(buffer)
        return Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
    }

    private fun scale(bitmap: Bitmap): Bitmap {
        val target = 720
        if (bitmap.width <= target) return bitmap
        val height = (bitmap.height * target / bitmap.width.toFloat()).toInt()
        return Bitmap.createScaledBitmap(bitmap, target, height, true)
    }

    private fun post(jpeg: ByteArray) {
        handler.post {
            try {
                val body = JSONObject().put("mime", "image/jpeg")
                    .put("imageBase64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
                    .put("at", System.currentTimeMillis()).toString()
                val connection = (URL("$hub/frame").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 8000
                    readTimeout = 8000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Authorization", "Bearer $token")
                }
                connection.outputStream.use { it.write(body.toByteArray()) }
                val code = connection.responseCode
                if (code != 200) Log.w(TAG, "取件中心拒绝了这一帧：$code")
                connection.disconnect()
            } catch (error: Exception) {
                Log.w(TAG, "没推上去：${error.message}")
            }
        }
    }

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "投屏", NotificationManager.IMPORTANCE_LOW))
        }
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("正在让她看你的屏幕")
            .setContentText("每 ${intervalMs / 1000} 秒一帧")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .build()
    }

    private fun release() {
        display?.release(); display = null
        reader?.close(); reader = null
        projection?.stop(); projection = null
    }

    override fun onDestroy() {
        release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "companion"
        private const val CHANNEL = "capture"
        private const val NOTIFICATION_ID = 1
    }
}
