package com.linmengyao.companion

import android.app.Activity
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * 只做三件事：填配置（取件中心地址、令牌、间隔）、申请截屏权限、把权限交给 CaptureService。
 * 界面用代码写，不引 Compose —— 这个 app 不需要好看的界面。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var hubView: EditText
    private lateinit var tokenView: EditText
    private lateinit var intervalView: EditText
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        hubView = EditText(this).apply {
            hint = "取件中心，例如 http://192.168.1.10:7789"
            setText(prefs.getString(KEY_HUB, ""))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        tokenView = EditText(this).apply {
            hint = "令牌（devices.json 里的 token）"
            setText(prefs.getString(KEY_TOKEN, ""))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        intervalView = EditText(this).apply {
            hint = "间隔秒数（最短 5）"
            setText(prefs.getInt(KEY_INTERVAL, 60).toString())
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        statusView = TextView(this).apply { text = "还没开始" }

        val start = Button(this).apply {
            text = "开始投屏"
            setOnClickListener {
                save(prefs)
                val manager = getSystemService(MediaProjectionManager::class.java)
                startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE)
            }
        }
        val stop = Button(this).apply {
            text = "停止"
            setOnClickListener {
                stopService(Intent(this@MainActivity, CaptureService::class.java))
                statusView.text = "已停止"
            }
        }

        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
            addView(TextView(context).apply { text = "让她看我的手机屏幕" })
            addView(hubView)
            addView(tokenView)
            addView(intervalView)
            addView(start)
            addView(stop)
            addView(statusView)
        })
    }

    private fun save(prefs: android.content.SharedPreferences) {
        val seconds = intervalView.text.toString().toIntOrNull()?.coerceAtLeast(5) ?: 60
        intervalView.setText(seconds.toString())
        prefs.edit()
            .putString(KEY_HUB, hubView.text.toString().trim().trimEnd('/'))
            .putString(KEY_TOKEN, tokenView.text.toString().trim())
            .putInt(KEY_INTERVAL, seconds)
            .apply()
    }

    @Deprecated("MediaProjection 的授权结果只能这样拿")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_CAPTURE || resultCode != Activity.RESULT_OK || data == null) {
            statusView.text = "没有授权，截不了屏"
            return
        }
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val intent = Intent(this, CaptureService::class.java).apply {
            putExtra(EXTRA_RESULT_CODE, resultCode)
            putExtra(EXTRA_RESULT_DATA, data)
            putExtra(EXTRA_HUB, prefs.getString(KEY_HUB, ""))
            putExtra(EXTRA_TOKEN, prefs.getString(KEY_TOKEN, ""))
            putExtra(EXTRA_INTERVAL, prefs.getInt(KEY_INTERVAL, 60))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
        statusView.text = "开始投屏：每 ${prefs.getInt(KEY_INTERVAL, 60)} 秒一帧"
    }

    companion object {
        const val PREFS = "companion"
        const val KEY_HUB = "hub"
        const val KEY_TOKEN = "token"
        const val KEY_INTERVAL = "interval"
        const val REQUEST_CAPTURE = 1001
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_HUB = "hub"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_INTERVAL = "interval"
    }
}
