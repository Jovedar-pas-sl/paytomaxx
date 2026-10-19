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
        // CI pasa -PversionCode=<nº de ejecución>: cada APK sube de versión y
        // PAXSTORE / Android aceptan instalarlo encima del anterior.
        versionCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
        // 0.2: cámara (QR) y NFC (fichas) para cobrar del saldo.
        versionName = "0.2.$versionCode"
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

    // Firma del APK de producción: solo si CI (o quien compile) da el almacén
    // de claves por variables de entorno. Sin ellas, el release sale sin firmar
    // y se usa el APK de prueba (debug), como hasta ahora.
    val keystore = System.getenv("PAX_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("PAX_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("PAX_KEY_ALIAS")
                keyPassword = System.getenv("PAX_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
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

dependencies {
    // Descodificar el QR de la cámara (ScanActivity). Java puro y ~0,5 MB: sin
    // AndroidX ni Google Play Services, que los PAX no traen (por eso no ML Kit
    // ni CameraX). La 3.3.x: la 3.4+ usa APIs de Java 8 que piden Android 7 (API 24).
    implementation("com.google.zxing:core:3.3.3")
}
