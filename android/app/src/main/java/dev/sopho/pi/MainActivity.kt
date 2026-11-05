package dev.sopho.pi

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import dev.sopho.pi.ui.ConnectScreen
import dev.sopho.pi.ui.DetailScreen
import dev.sopho.pi.ui.SessionListScreen
import dev.sopho.pi.ui.SophoTheme
import dev.sopho.pi.ui.Tokens

class MainActivity : ComponentActivity() {

    private lateinit var state: AppState

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        state = AppState(applicationContext)
        setContent {
            SophoTheme {
                Surface(modifier = Modifier.fillMaxSize().background(Tokens.bg)) {
                    androidx.compose.foundation.layout.Box(
                        modifier = Modifier.fillMaxSize().safeDrawingPadding(),
                    ) {
                        when (state.screen) {
                            Screen.CONNECT -> ConnectScreen(state)
                            Screen.LIST -> SessionListScreen(state)
                            Screen.DETAIL -> DetailScreen(state)
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        state.onResume()
    }

    override fun onPause() {
        state.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        state.close()
        super.onDestroy()
    }
}
