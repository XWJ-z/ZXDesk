plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // 版本清单的 JSON 复用 core/connection 的 MiniJson —— 不为了几个字段引第二个 JSON 库
    implementation(project(":core:connection"))
    implementation(libs.coroutines.core)
    // 版本接口与安装包下载走 OkHttp：与登录链路同一套 HTTP 栈，TLS 与重定向行为一致
    // ⚠️ 用 api 而不是 implementation：UpdateClient / ApkDownloader 的构造参数里出现了 OkHttpClient，
    //    app 模块实例化时必须能在自己的 classpath 上解析这个类型
    api(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
