plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // FNID 查询要切到 IO 线程；core/connection 是纯 JVM 模块，用 core 而不是 android
    implementation(libs.coroutines.core)
    // 原生 WS 登录（0.2.2）：手写 RFC6455 不如用现成的，任务单允许引 OkHttp
    implementation(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
