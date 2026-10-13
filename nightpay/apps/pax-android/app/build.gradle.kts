plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nightpay.pax"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nightpay.pax"
        // PAX A920 (Android 5.1 / 7.1) y A920 Pro.
        minSdk = 22
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // Pantalla del datáfono servida por la web del operador. Otro dominio:
        // gradle assembleDebug -PpaxUrl=https://operator.nuevodominio.com/pax
        val paxUrl = (project.findProperty("paxUrl") as String?)?.takeIf { it.isNotBlank() }
            ?: "https://operator.paytomaxx.com/pax"
        buildConfigField("String", "PAX_URL", "\"$paxUrl\"")
        // Device API de Paytef en el propio datáfono.
        buildConfigField("String", "PAYTEF_URL", "\"http://127.0.0.1:8887\"")
        // Depurar la WebView desde un PC: apagado siempre (también en el APK de prueba).
        buildConfigField("boolean", "ALLOW_WEB_DEBUG", "false")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
