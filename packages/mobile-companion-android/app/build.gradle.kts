plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "com.linmengyao.companion"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.linmengyao.companion"
        minSdk = 26
        targetSdk = 35
        versionCode = 7
        versionName = "0.3.4"
        val companionUrl = providers.gradleProperty("COMPANION_URL").orElse("https://companion.invalid/").get()
        buildConfigField("String", "COMPANION_URL", "\"${companionUrl.replace("\"", "\\\"")}\"")
    }
    buildFeatures { buildConfig = true }
}

gradle.taskGraph.whenReady {
    if (allTasks.any { it.name.contains("release", ignoreCase = true) }) {
        val companionUrl = providers.gradleProperty("COMPANION_URL").orElse("").get()
        require(companionUrl.startsWith("https://") && !companionUrl.contains(".invalid")) {
            "release 构建必须通过 -PCOMPANION_URL 提供正式 HTTPS 地址"
        }
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
