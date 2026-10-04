#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';

const out = '.builder/generated/android';
mkdirSync(out + '/app/src/main/java/com/builder/app', { recursive: true });
mkdirSync(out + '/app/src/main/res/values', { recursive: true });
mkdirSync(out + '/app/src/main/res/drawable', { recursive: true });
mkdirSync(out + '/gradle/wrapper', { recursive: true });

writeFileSync(out + '/settings.gradle.kts', 'rootProject.name = "builderapp"\ninclude(":app")\n');
writeFileSync(out + '/build.gradle.kts', `buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath("com.android.tools.build:gradle:8.5.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.24")
    }
}
allprojects { repositories { google(); mavenCentral() } }
tasks.register("clean", Delete::class) { delete(rootProject.buildDir) }
`);
writeFileSync(out + '/gradle.properties', `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
`);
writeFileSync(out + '/app/build.gradle.kts', `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.builder.app"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.builder.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.14" }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
`);
writeFileSync(out + '/app/src/main/AndroidManifest.xml', `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="BuilderApp">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);
writeFileSync(out + '/app/src/main/java/com/builder/app/MainActivity.kt', `package com.builder.app
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { Text("Builder App") }
  }
}
`);
writeFileSync(out + '/gradle/wrapper/gradle-wrapper.properties', `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\://services.gradle.org/distributions/gradle-8.7-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`);
writeFileSync(out + '/gradlew', `#!/usr/bin/env sh
exec gradle "$@"
`);
writeFileSync(out + '/app/proguard-rules.pro', '');
console.log('Android app generated');
