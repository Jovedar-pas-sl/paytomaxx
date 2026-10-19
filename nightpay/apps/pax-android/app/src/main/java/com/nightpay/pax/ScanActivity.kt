package com.nightpay.pax

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.Camera
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * Escanea un QR con la cámara trasera del datáfono y lo descodifica con ZXing
 * (Java puro). API de cámara clásica: no hace falta AndroidX ni Google Play
 * Services (los PAX no los traen) y va desde Android 5.1.
 *
 * Devuelve EXTRA_TEXT (RESULT_OK) o EXTRA_ERROR + EXTRA_MESSAGE (RESULT_CANCELED):
 * cancelled · permissionDenied · noCamera.
 */
@Suppress("DEPRECATION") // android.hardware.Camera y defaultDisplay: sin AndroidX, lo que hay en API 22.
class ScanActivity : Activity(), SurfaceHolder.Callback, Camera.PreviewCallback {

    private val ui = Handler(Looper.getMainLooper())
    private val decodeThread = HandlerThread("qr-decode")
    private lateinit var decodeHandler: Handler
    private lateinit var surface: SurfaceView

    private val reader = QRCodeReader()
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true)

    private var camera: Camera? = null
    private var surfaceReady = false
    private var previewWidth = 0
    private var previewHeight = 0

    @Volatile
    private var decoding = false

    @Volatile
    private var finished = false

    /** Con enfoque "auto" (sin continuo), se vuelve a enfocar cada poco. */
    private val focusAgain = object : Runnable {
        override fun run() {
            val cam = camera ?: return
            try {
                cam.autoFocus { _, _ -> }
            } catch (e: RuntimeException) {
                // enfocando aún: la próxima vuelta
            }
            ui.postDelayed(this, FOCUS_EVERY_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        decodeThread.start()
        decodeHandler = Handler(decodeThread.looper)
        surface = SurfaceView(this)
        surface.holder.addCallback(this)
        setContentView(layout())
        if (!hasCameraPermission() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        startCameraIfReady()
    }

    override fun onPause() {
        stopCamera()
        super.onPause()
    }

    override fun onDestroy() {
        stopCamera()
        decodeThread.quitSafely()
        super.onDestroy()
    }

    @Deprecated("Activity sin AndroidX: onBackPressed sigue funcionando")
    override fun onBackPressed() {
        finishWith(RESULT_CANCELED, null, "cancelled", "Cancelado")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startCameraIfReady()
        } else {
            finishWith(RESULT_CANCELED, null, "permissionDenied", "Sin permiso para usar la cámara")
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        surfaceReady = true
        startCameraIfReady()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        surfaceReady = false
        stopCamera()
    }

    /** Cada fotograma (NV21): uno a la vez se descodifica en su hilo; los demás se saltan. */
    override fun onPreviewFrame(data: ByteArray?, cam: Camera?) {
        val w = previewWidth
        val h = previewHeight
        if (data == null || decoding || finished || w <= 0 || h <= 0 || data.size < w * h) return
        decoding = true
        decodeHandler.post { decode(data, w, h) }
    }

    private fun decode(data: ByteArray, w: Int, h: Int) {
        try {
            // El QR se lee girado: no hace falta rotar el fotograma.
            val source = PlanarYUVLuminanceSource(data, w, h, 0, 0, w, h, false)
            val text = reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
            if (!text.isNullOrEmpty()) {
                val value = text.take(MAX_TEXT)
                ui.post { finishWith(RESULT_OK, value, null, null) }
            }
        } catch (e: ReaderException) {
            // sin QR en este fotograma
        } catch (e: RuntimeException) {
            // fotograma raro: el siguiente
        } finally {
            reader.reset()
            decoding = false
        }
    }

    private fun hasCameraPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCameraIfReady() {
        if (camera != null || !surfaceReady || finished || !hasCameraPermission()) return
        val id = backCameraId()
        if (id < 0) {
            finishWith(RESULT_CANCELED, null, "noCamera", "Este datáfono no tiene cámara")
            return
        }
        val cam = try {
            Camera.open(id)
        } catch (e: RuntimeException) {
            null
        }
        if (cam == null) {
            finishWith(RESULT_CANCELED, null, "noCamera", "La cámara está ocupada")
            return
        }
        try {
            val focus = configure(cam, id)
            cam.setPreviewDisplay(surface.holder)
            cam.setPreviewCallback(this)
            cam.startPreview()
            camera = cam
            if (focus == Camera.Parameters.FOCUS_MODE_AUTO) ui.post(focusAgain)
        } catch (e: Exception) {
            cam.release()
            finishWith(RESULT_CANCELED, null, "noCamera", "No se ha podido abrir la cámara")
        }
    }

    /** Tamaño de vista previa razonable (cuanto más grande, más lento), enfoque y giro. Devuelve el enfoque. */
    private fun configure(cam: Camera, id: Int): String? {
        val params = cam.parameters
        val size = (params.supportedPreviewSizes ?: emptyList<Camera.Size>())
            .filter { it.width * it.height <= MAX_PREVIEW_PIXELS }
            .maxByOrNull { it.width * it.height }
        if (size != null) params.setPreviewSize(size.width, size.height)
        val modes = params.supportedFocusModes ?: emptyList<String>()
        val focus = listOf(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE, Camera.Parameters.FOCUS_MODE_AUTO)
            .firstOrNull { it in modes }
        if (focus != null) params.focusMode = focus
        try {
            cam.parameters = params
        } catch (e: RuntimeException) {
            // el aparato no admite alguno: se queda con los de serie
        }
        val actual = cam.parameters
        previewWidth = actual.previewSize.width
        previewHeight = actual.previewSize.height
        cam.setDisplayOrientation(displayOrientation(id))
        return actual.focusMode
    }

    private fun backCameraId(): Int {
        val count = Camera.getNumberOfCameras()
        val info = Camera.CameraInfo()
        for (i in 0 until count) {
            Camera.getCameraInfo(i, info)
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) return i
        }
        return if (count > 0) 0 else -1
    }

    private fun displayOrientation(id: Int): Int {
        val info = Camera.CameraInfo()
        Camera.getCameraInfo(id, info)
        val degrees = when (windowManager.defaultDisplay.rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
        return if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            (360 - (info.orientation + degrees) % 360) % 360
        } else {
            (info.orientation - degrees + 360) % 360
        }
    }

    private fun stopCamera() {
        ui.removeCallbacks(focusAgain)
        val cam = camera ?: return
        camera = null
        try {
            cam.setPreviewCallback(null)
            cam.stopPreview()
        } catch (e: RuntimeException) {
            // ya parada
        }
        cam.release()
    }

    private fun finishWith(resultCode: Int, text: String?, error: String?, message: String?) {
        if (finished) return
        finished = true
        stopCamera()
        val data = Intent()
        if (text != null) data.putExtra(EXTRA_TEXT, text)
        if (error != null) data.putExtra(EXTRA_ERROR, error)
        if (message != null) data.putExtra(EXTRA_MESSAGE, message)
        setResult(resultCode, data)
        finish()
    }

    /** Vista de la cámara a pantalla completa, un recuadro de guía, el aviso y "Cancelar". */
    private fun layout(): FrameLayout {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        root.addView(surface, FrameLayout.LayoutParams(MATCH, MATCH))

        val guide = View(this)
        guide.background = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            setStroke(dp(4), Color.WHITE)
            setCornerRadius(dp(16).toFloat())
        }
        root.addView(guide, FrameLayout.LayoutParams(dp(240), dp(240), Gravity.CENTER))

        val hint = TextView(this)
        hint.setText(R.string.scan_hint)
        hint.setTextColor(Color.WHITE)
        hint.textSize = 20f
        hint.gravity = Gravity.CENTER
        hint.setPadding(dp(16), dp(24), dp(16), dp(16))
        hint.setBackgroundColor(Color.argb(160, 0, 0, 0))
        root.addView(hint, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.TOP))

        val cancel = Button(this)
        cancel.setText(R.string.scan_cancel)
        cancel.textSize = 20f
        cancel.setOnClickListener { finishWith(RESULT_CANCELED, null, "cancelled", "Cancelado") }
        val cancelParams = FrameLayout.LayoutParams(MATCH, dp(64), Gravity.BOTTOM)
        cancelParams.setMargins(dp(16), 0, dp(16), dp(24))
        root.addView(cancel, cancelParams)
        return root
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_TEXT = "text"
        const val EXTRA_ERROR = "error"
        const val EXTRA_MESSAGE = "message"
        private const val REQUEST_CAMERA = 7
        private const val MAX_PREVIEW_PIXELS = 1280 * 720
        private const val MAX_TEXT = 2048
        private const val FOCUS_EVERY_MS = 2500L
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
