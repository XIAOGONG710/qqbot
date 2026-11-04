plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

android {
    namespace = "com.linmengyao.companion"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.linmengyao.companion"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        val companionUrl = providers.gradleProperty("COMPANION_URL").orElse("https://companion.invalid/").get()
        buildConfigField("String", "COMPANION_URL", "\"${companionUrl.replace("\"", "\\\"")}\"")
    }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
