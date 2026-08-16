package com.newmark.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.newmark.mobile.ui.NewmarkApp
import com.newmark.mobile.ui.theme.NewmarkTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            NewmarkTheme {
                NewmarkApp()
            }
        }
    }
}
