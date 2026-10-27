plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.zxdesk.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zxdesk.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 16
        versionName = "0.2.14"
    }

    buildFeatures {
        compose = true
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
    implementation(project(":core:datasource"))
    implementation(project(":core:connection"))
    implementation(project(":core:tls"))
    // 版本检测 / 下载 / 校验（0.2.13）：纯 Kotlin/JVM，逻辑与界面分开，单测不用真机
    implementation(project(":core:update"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    // 登录流程要活过「切到验证器再回来」：ViewModel 作用域 + 前台/后台感知
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.coroutines.android)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
}
