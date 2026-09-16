package com.newmark.mobile.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.newmark.mobile.data.*
import com.newmark.mobile.ui.components.LucideIcons
import com.newmark.mobile.ui.theme.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

class Dev065PopupModelsTest {
 @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
 private fun settle() { compose.mainClock.advanceTimeBy(1100); compose.waitForIdle(); Thread.sleep(350); compose.mainClock.advanceTimeBy(500); compose.waitForIdle() }
 private fun shot(name:String) { val image=compose.onNodeWithTag("root").captureToImage(); File(compose.activity.getExternalFilesDir(null),"dev065-$name.png").outputStream().use { image.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) } }
 @Test fun modelRowLandsThenEditsOnlyItsProvider() {
  val a=ProviderConfig(id="a",name="Provider A",models=listOf(ModelConfig(name="same",display="Alpha")))
  val b=mutableStateOf(ProviderConfig(id="b",name="Provider B",models=listOf(ModelConfig(name="same",display="Beta"))))
  val editing=mutableStateOf(false); var saved:ModelConfig?=null
  compose.setContent { NewmarkTheme(darkTheme=true) { Box(Modifier.fillMaxSize().background(LocalNewmarkColors.current.bgPrimary).testTag("root")) {
   if(editing.value) ManualModelPage(provider=b.value,initialModel=b.value.models[0],onSave={saved=it;b.value=b.value.copy(models=listOf(it));editing.value=false},onCancel={editing.value=false})
   else ProviderDetailPanel(b.value,{},{},{},{},{},{},onEditModel={assertEquals("same",it);editing.value=true})
  } } }; settle(); shot("provider-before")
  compose.mainClock.autoAdvance=false
  compose.onNodeWithText("Beta").performTouchInput { click() }
  assertFalse(editing.value);compose.mainClock.advanceTimeBy(150);assertFalse(editing.value)
  settle();assertTrue(editing.value);shot("model-edit")
  compose.mainClock.autoAdvance=true
  compose.onAllNodes(hasSetTextAction())[0].performTextReplacement("same-renamed")
  compose.onAllNodes(hasSetTextAction())[1].performTextReplacement("Friendly Beta")
  compose.onNodeWithText("保存模型").performScrollTo().performClick();settle()
  assertEquals("same-renamed",saved?.name);assertEquals("Friendly Beta",saved?.display)
  assertEquals("same",a.models[0].name);assertEquals("Alpha",a.models[0].display);shot("provider-after")
 }
 @Test fun modelMenuOpensAtSelectionAndBackDoesNotSelect() {
  var selections=0
  val options=(0..29).map { ModelOption(providerId="p$it",modelName="same",label="Provider $it / Model $it",providerLabel="Provider $it",displayName="Model $it") }
  compose.setContent { NewmarkTheme(darkTheme=true) { Box(Modifier.fillMaxSize().testTag("root")) { ChatScreen(title="Popup test",items=emptyList(),isSending=false,showMenuButton=false,onMenuClick={},onNewChat={},onSend={},modelOptions=options,selectedModel="Provider 25 / Model 25",selectedProviderId="p25",selectedModelName="same",onSelectModel={selections++}) } } };settle()
  compose.onNodeWithContentDescription("模型").performTouchInput { click() };settle()
  shot("menu-main");compose.onNodeWithText("模型选择", useUnmergedTree = true).performTouchInput { click() };settle()
  shot("menu-current-selection");compose.onNodeWithText("Model 25").assertIsDisplayed()
  compose.onNodeWithText("← 返回").performScrollTo().performTouchInput { click() };settle()
  assertEquals(0,selections);compose.onNodeWithText("模型选择").assertIsDisplayed();shot("menu-back")
  shot("menu-main");compose.onNodeWithText("模型选择", useUnmergedTree = true).performTouchInput { click() };settle()
  compose.onNodeWithText("Model 25").assertIsDisplayed();shot("menu-reopened")
 }
 @Test fun viewModelRenameKeepsSameNamedSiblingProvider() {
  val a=ProviderConfig(id="dev065-a",name="A",models=listOf(ModelConfig(name="same",display="Alpha")))
  val b=ProviderConfig(id="dev065-b",name="B",models=listOf(ModelConfig(name="same",display="Beta")))
  ProviderStore(compose.activity.application).save(listOf(a,b))
  lateinit var vm:com.newmark.mobile.vm.ChatViewModel
  compose.activityRule.scenario.onActivity { vm=androidx.lifecycle.ViewModelProvider(it)[com.newmark.mobile.vm.ChatViewModel::class.java] }
  compose.waitUntil(10000) { vm.providers.any { it.id == b.id } }
  compose.runOnIdle { vm.editModel(b.id,"same",b.models[0].copy(name="renamed",display="Friendly B")) }
  assertEquals(a.models,vm.providers.find{it.id==a.id}?.models)
  assertEquals("renamed",vm.providers.find{it.id==b.id}?.models?.single()?.name)
  assertEquals("Friendly B",vm.providers.find{it.id==b.id}?.models?.single()?.display)
 }
 @Test fun toolbarHasUnclippedHeldOptics() {
  var calls=0
  compose.setContent { NewmarkTheme(darkTheme=true) { Box(Modifier.fillMaxSize().background(LocalNewmarkColors.current.bgPrimary).testTag("root")) { Row(Modifier.padding(32.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
   EditorToolbarButton(LucideIcons.ArrowLeft,"后退",true){calls++}
   EditorToolbarButton(LucideIcons.ArrowRight,"前进",true){calls++}
   EditorToolbarButton(LucideIcons.RefreshCw,"刷新",true){calls++}
  } } } };settle();shot("browser-idle")
  compose.mainClock.autoAdvance=false
  compose.onNodeWithContentDescription("刷新").performTouchInput { down(center) };compose.mainClock.advanceTimeBy(350);shot("browser-held")
  compose.onNodeWithContentDescription("刷新").performTouchInput { up() };settle();assertEquals(1,calls);shot("browser-landed")
 }
}
