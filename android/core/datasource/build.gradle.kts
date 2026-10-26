plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":core:connection"))
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
