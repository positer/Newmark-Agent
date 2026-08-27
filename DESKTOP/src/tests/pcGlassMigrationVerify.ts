import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * dev-0.5.6 PC GUI 自制玻璃 → 移植玻璃迁移回归门。
 *
 * 菜单壳（conv-action-menu / model-select-menu / newmark-select-menu）保留
 * 一层 .liquid-glass；外围栏和按钮保持原有静态表面，按钮只在按下时
 * 通过伪元素浮起一层交互玻璃。
 */
function uiHtml(): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf-8');
}

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

function main(): void {
  const html = uiHtml();
  const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.ts'), 'utf-8');

  // 1) 外围主要表面挂 .liquid-glass；中心输入/终端保持实体表面
  check(/id="topbar"(?![^>]*liquid-glass)/.test(html), '#topbar 恢复原有静态表面');
  check(/id="left-secondary"(?![^>]*liquid-glass)/.test(html), '#left-secondary 恢复原有静态表面');
  check(/id="input-area"(?![^>]*liquid-glass)/.test(html), '#input-area 本体不使用玻璃');
  check(/id="bottom" class="open"/.test(html), '#bottom 本体不使用玻璃');
  check(/id="right" class="open"/.test(html), '#right 恢复原有静态表面');

  // 2) 弹层菜单挂 .liquid-glass
  check(/class="conv-action-menu liquid-glass liquid-glass-carrier"/.test(html), '.conv-action-menu 使用磨砂承载玻璃');
  check(/class="model-select-menu liquid-glass liquid-glass-carrier"/.test(html), '.model-select-menu 使用磨砂承载玻璃');
  check(/newmark-select-menu liquid-glass liquid-glass-carrier'/.test(html), '.newmark-select-menu（JS 创建）使用磨砂承载玻璃');

  // 3) 外围表面恢复各自原有静态模糊；输入区/终端保持实体
  const topbarBlock = extractRule(html, '#topbar');
  check(/backdrop-filter:\s*blur/.test(topbarBlock), '#topbar 保留原有静态模糊');
  const inputAreaBlock = extractRule(html, '#input-area');
  check(!/backdrop-filter/.test(inputAreaBlock), '#input-area 无重复内联 backdrop-filter');
  const menuBlock = extractRule(html, '.conv-action-menu');
  check(!/backdrop-filter/.test(menuBlock), '.conv-action-menu 无重复内联 backdrop-filter');
  check(/\.conv-action-menu\.liquid-glass,[\s\S]*\.newmark-select-menu\.liquid-glass\s*\{[^}]*box-shadow:\s*none/s.test(html) &&
    /\.conv-action-menu\.liquid-glass::before,[\s\S]*\.newmark-select-menu\.liquid-glass::before\s*\{[^}]*background:\s*none;[^}]*opacity:\s*0/s.test(html) &&
    /\.conv-action-menu\.liquid-glass::after,[\s\S]*\.newmark-select-menu\.liquid-glass::after\s*\{[^}]*box-shadow:\s*none/s.test(html),
    'PC List 弹窗停止绘制旧版固定外阴影、整面明暗渐变和内阴影');

  // 4) 主要表面保留 position: relative（.liquid-glass 伪元素定位上下文）
  check(/id="input-area"(?![^>]*liquid-glass)/.test(html), '#input-area 不挂玻璃类');

  // 5) .liquid-glass 定义完整（含伪元素）
  check(/\.liquid-glass\s*\{[^}]*backdrop-filter/.test(html), '.liquid-glass 定义含 backdrop-filter');
  check(/\.liquid-glass::before\s*\{/.test(html), '.liquid-glass::before 折射渐变存在');
  check(/\.liquid-glass::after\s*\{/.test(html), '.liquid-glass::after 边缘光存在');

  // 6) JSDOM 解析：HTML 结构完整、无破坏
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  check(doc.getElementById('topbar')?.classList.contains('liquid-glass') === false, 'JSDOM：#topbar 静态不含 liquid-glass');
  check(doc.getElementById('bottom')?.classList.contains('liquid-glass') === false, 'JSDOM：#bottom 不含 liquid-glass');
  check(doc.getElementById('right')?.classList.contains('liquid-glass') === false, 'JSDOM：#right 静态不含 liquid-glass');
  check(doc.getElementById('input-area')?.classList.contains('liquid-glass') === false, 'JSDOM：#input-area 不含 liquid-glass');
  check(doc.getElementById('left-secondary')?.classList.contains('liquid-glass') === false, 'JSDOM：#left-secondary 静态不含 liquid-glass');
  check(!!doc.getElementById('chat-area'), 'JSDOM：核心布局元素 #chat-area 保留');
  check(!!doc.getElementById('model-select-menu'), 'JSDOM：核心布局元素 #model-select-menu 保留');
  check(!!doc.getElementById('conversation-action-menu'), 'JSDOM：核心布局元素 #conversation-action-menu 保留');
  check(/button::after\s*\{[^}]*backdrop-filter:\s*blur\(calc\(var\(--glass-blur-3\) \* 4\)\)[^}]*saturate\(145%\)/s.test(html), 'PC button 交互玻璃模糊接入统一强度变量');
  check(/button:active:not\(:disabled\)::after\s*\{\s*opacity:\s*1/.test(html), 'PC button 按下时浮起玻璃层');
  check(!/button\s*\{[^}]*backdrop-filter/s.test(html), 'PC button 静态不常驻玻璃');
  check(html.includes('function wireLiquidMenuInteractions(menu)') &&
    html.includes('source.classList.add(\'liquid-selection-source\')') &&
    html.includes('float.classList.add(\'visible\')') &&
    html.includes("window.addEventListener('pointermove', onPointerMove, true)") &&
    html.includes('positionAlongPointer(event)'),
    'PC select 菜单从原选中项淡入浮起玻璃并在窗口级持续定轨拖动');
  check(/--liquid-interaction-edge:\s*6px/.test(html) &&
    /\.liquid-selection-float\.visible\s*\{[^}]*opacity:\s*1[^}]*--liquid-lift-scale:\s*1/s.test(html) &&
    html.includes("liquidGlassCssNumber('--liquid-interaction-edge', 6)") &&
    /rect\.left - edge[\s\S]*rect\.top - edge[\s\S]*rect\.width \+ edge \* 2[\s\S]*rect\.height \+ edge \* 2/s.test(html),
    'PC 菜单活动玻璃使用共享 token 四边固定 6px 包边，不按比例拉长');
  const floatingGlassBlock = extractRule(html, '.liquid-selection-float');
  check(html.includes('function startLiquidMotionTracking(float)') &&
    html.includes("float.style.setProperty('--liquid-motion-angle'") &&
    html.includes("float.style.setProperty('--liquid-motion-stretch'") &&
    html.includes("float.style.setProperty('--liquid-motion-squash'") &&
    html.includes('float.appendChild(displayCanvas)') &&
    /transform:\s*scale\(var\(--liquid-lift-scale\)\)\s*rotate\(var\(--liquid-motion-angle\)\)/.test(floatingGlassBlock) &&
    /--liquid-motion-stretch:\s*1/.test(floatingGlassBlock),
    'PC 浮块按实时速度方向轻度拉伸/正交收缩，折射展示画布共享同一合成变换');
  check(/background-color:\s*transparent\s*!important/.test(floatingGlassBlock) &&
    /backdrop-filter:\s*none;/.test(floatingGlassBlock) &&
    !/saturate|brightness/.test(floatingGlassBlock),
    'PC 浮块完全透明且不再模糊/染色下方选项');
  check(!/\.liquid-selection-float::before\s*\{[^}]*conic-gradient/s.test(html) &&
    !/-3px 0 9px rgba\(76,178,255/.test(floatingGlassBlock),
    'PC 浮块不使用预烘焙光谱遮罩或青紫伪泛光');
  check(html.includes('function attachKyantLiquidRenderer(float, frame)') &&
    html.includes("canvas.getContext('webgl2'") &&
    html.includes('float radiusAt') &&
    html.includes('uniform vec4 cornerRadii') &&
    html.includes('uniform float chromaticAberration') &&
    html.includes('float sdRoundedRect') &&
    html.includes('float circleMap') &&
    html.includes('float dispersionIntensity=chromaticAberration*edge') &&
    !html.includes('(centered.x*centered.y)/(halfSize.x*halfSize.y)') &&
    html.includes('vec2 dispersed=d*grad*dispersionIntensity') &&
    html.includes('vec4 red=sampleBackdrop(refracted+dispersed)') &&
    html.includes('vec4 green=sampleBackdrop(refracted)') &&
    html.includes('vec4 blue=sampleBackdrop(refracted-dispersed)') &&
    !html.includes('vec4 orange=sampleBackdrop') &&
    !html.includes('vec4 yellow=sampleBackdrop') &&
    !html.includes('vec4 cyan=sampleBackdrop') &&
    !html.includes('vec4 purple=sampleBackdrop') &&
    html.includes('float alpha=mix(.14,.82,edge)') &&
    html.includes('outColor=vec4(vec3(red.r,green.g,blue.b)*alpha,alpha)') &&
    html.includes("float.dataset.kyantRenderer = 'webgl2'") &&
    html.includes("chromaticAberration: gl.getUniformLocation(program,'chromaticAberration')") &&
    html.includes('gl.uniform1f(uniforms.chromaticAberration,configuredChromatic)'),
    'PC WebGL2 保留 Kyant SDF/circleMap 原流程，仅以红绿蓝三次实时采样重建色散');
  check(html.includes('var menuRect = menu.getBoundingClientRect()') &&
    html.includes('var clipTop = Math.max(0, menuRect.top + menu.clientTop + 7)') &&
    html.includes('var clipBottom = Math.min(window.innerHeight, menuRect.bottom - menu.clientTop - 7)') &&
    html.includes('return rect.bottom > clipTop && rect.top < clipBottom') &&
    !html.includes('return rect.top >= clipTop && rect.bottom <= clipBottom') &&
    html.includes('var minCenter = Math.min(firstRect.top + firstRect.height / 2, lastRect.top + lastRect.height / 2)') &&
    html.includes('var centerY = Math.max(minCenter, Math.min(maxCenter, event.clientY))'),
    'PC 可滚动弹窗仅排除完全不可见选项，部分可见项仍允许浮块继续移动');
  check(html.includes('var minTop = firstRect.top - rowRect.height') &&
    html.includes('var maxTop = Math.max(minTop, lastRect.bottom)') &&
    html.includes('var trackTop = Math.max(minTop, Math.min(maxTop, projectedTop))') &&
    html.includes("drag.float.style.left = (rowRect.left - edge) + 'px'") &&
    html.includes("drag.float.style.top = (trackTop - edge) + 'px'") &&
    html.includes('if (clientY <= firstPeerRect.top)') &&
    html.includes('list.insertBefore(drag.row, peers[0])') &&
    html.includes('if (clientY >= lastPeerRect.bottom)') &&
    html.includes('list.insertBefore(drag.row, peers[peers.length - 1].nextSibling)'),
    'PC 对话拖动固定横向轨道并覆盖同组首前、末后完整插入槽');
  check(/\.liquid-glass-carrier\s*\{[^}]*blur\(var\(--carrier-glass-blur\)\)[^}]*background:/s.test(html) ||
    /\.liquid-glass-carrier\s*\{[^}]*background:[^}]*blur\(var\(--carrier-glass-blur\)\)/s.test(html),
    '弹窗承载玻璃使用独立底图磨砂层');
  check(html.includes('class="sub-win liquid-glass liquid-glass-carrier"'),
    '设置等大型弹窗使用折射外壳加底图磨砂承载层');
  check(html.includes("root.style.setProperty('--carrier-glass-blur'") &&
    html.includes("root.style.setProperty('--liquid-float-refraction-amount'") &&
    html.includes("liquidGlassCssNumber('--liquid-interaction-edge', 6)") &&
    html.includes("liquidGlassCssNumber('--liquid-float-chromatic-aberration'"),
    '玻璃强度滑条同时驱动承载磨砂与浮块实时折射色散');
  check(html.includes('captureLiquidBackdropFrame()') &&
    html.includes('window.api.captureLiquidBackdrop({ width: window.innerWidth, height: window.innerHeight })') &&
    html.includes('attachKyantLiquidRenderer(float, backdropFrame)'),
    'PC 交互开始捕获真实窗口 backdrop 并交给浮块 GPU 纹理');
  check(mainSource.includes("resized.toJPEG(82)") &&
    mainSource.includes("mimeType: 'image/jpeg'") &&
    mainSource.includes("image.resize({ width, height, quality: 'good' })") &&
    html.includes("createImageBitmap(blob)"),
    'PC backdrop 使用 CSS 像素 JPEG 二进制与 ImageBitmap 解码，避免高 DPI PNG 编解码尖峰');
  check(html.includes('Array.isArray(bytes.data)') &&
    html.includes('frame.dataUrl ? fetch(frame.dataUrl)') &&
    html.includes('return liquidBackdropCachedFrame;'),
    'PC backdrop 解码兼容 Buffer 对象和旧 dataUrl 协议，失败时保留上一帧避免黑块');
  check(html.includes('captureLiquidBackdropFrame().then(function(backdropFrame)') &&
    html.includes("float = document.createElement('div')") &&
    html.indexOf("float = document.createElement('div')") < html.indexOf('captureLiquidBackdropFrame().then(function(backdropFrame)') &&
    html.includes('var liquidKyantRendererPool = []') &&
    html.includes('function acquireKyantLiquidRenderer(float)') &&
    html.includes('function prewarmKyantRenderer(frame)') &&
    html.includes('attachKyantLiquidRenderer(float, liquidBackdropCachedFrame)') &&
    html.includes('renderer.frameId === frame.id') &&
    html.includes('renderer.generation === generation') &&
    html.includes('gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame.bitmap)') &&
    !html.includes('var liquidSelectionFloatPool = null') &&
    !html.includes('function acquireLiquidSelectionFloat(frame)'),
    'PC 悬停预热已解码纹理，交互首帧立即复用并在新捕获到达后原位刷新');
  check(html.includes("if (canvas.width !== pixelWidth) canvas.width = pixelWidth") &&
    html.includes("if (canvas.height !== pixelHeight) canvas.height = pixelHeight") &&
    html.includes('if (!renderer.textureReady || renderer.owner !== float || !float.isConnected) return') &&
    html.includes('if (immediate) draw()') &&
    html.includes('else renderer.renderFrame = requestAnimationFrame(draw)') &&
    html.includes("uniformChanged('origin'") &&
    html.includes('renderer.lastGeometry === geometryKey') &&
    html.includes("size: gl.getUniformLocation(program,'size')"),
    'PC 玻璃绘制合并同帧请求、跳过重复几何/uniform 并避免重复分配 drawing buffer');
  check(html.includes("canvas.getContext('webgl2', { alpha:true, antialias:false, premultipliedAlpha:true, powerPreference:'high-performance' })") &&
    !html.includes('desynchronized:true'),
    'PC 透明 WebGL 使用标准预乘 alpha 并禁用可能丢失 alpha 的 desynchronized swap chain');
  check(html.includes("displayCanvas.className = 'liquid-selection-canvas'") &&
    html.includes('renderer.displayCanvas.remove();') &&
    html.includes('if (displayCanvas.parentNode !== float) float.appendChild(displayCanvas)') &&
    html.indexOf("gl.drawArrays(gl.TRIANGLES,0,6)") < html.indexOf('displayContext.drawImage(canvas,0,0)') &&
    html.includes('displayContext.drawImage(canvas,0,0)'),
    'PC WebGL 离屏着色后同步复制到透明 2D surface，避开 Windows 重挂载 WebGL 黑帧');
  check(html.includes('gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)') &&
    html.includes('1.-cssCoord.y/viewport.y'),
    'PC backdrop 恢复原纹理上传与 shader 坐标流程');
  check(html.includes('if(-sd>=refractionHeight){outColor=vec4(0.);return;}') &&
    html.includes("mix(.14,.82,edge)") &&
    !html.includes('gl.readPixels('),
    'PC 浮块中心保持透明，仅在固定边缘增强折射色散且无生产同步像素回读');
  check(!/\.liquid-selection-canvas\s*\{[^}]*top\s*\/\s*100% 9px no-repeat/s.test(html) &&
    !/\.liquid-selection-canvas\s*\{[^}]*padding:\s*9px/s.test(html),
    'PC WebGL canvas 恢复原完整画布，不再使用导致黑色包边的 9px 遮罩');
  check(/\.liquid-selection-float\s*\{[^}]*overflow:\s*visible/s.test(html) &&
    /\.liquid-selection-float::-webkit-scrollbar\s*\{\s*display:\s*none/.test(html),
    'PC top-layer 浮块边缘可越界绘制且不生成滚动扩展区滑条');
  check(/button\s*\{\s*border-radius:\s*var\(--radius-full\)\s*!important/.test(html),
    'PC 所有按钮统一为胶囊，等宽按钮自然为圆形');
  check(!html.includes('flightUntil = performance.now() + 350') &&
    html.includes('requestAnimationFrame(function() { if (float) position(target); })') &&
    /transition:\s*top 240ms/.test(floatingGlassBlock) &&
    html.includes('function waitForLiquidSelectionArrival(float, onArrive)') &&
    html.includes('waitForLiquidSelectionArrival(float, function()') &&
    !html.includes('remainingClickFlight') &&
    !html.includes('liquid-selection-click-paced') &&
    /\.liquid-selection-float\.liquid-selection-landing\s*\{[^}]*opacity:\s*0[^}]*--liquid-lift-scale:\s*\.86[^}]*--liquid-motion-stretch[^}]*120ms/s.test(html) &&
    html.indexOf('stopLiquidMotionTracking(float);', html.indexOf('function landLiquidSelectionFloat')) < html.indexOf("float.classList.add('liquid-selection-landing')", html.indexOf('function landLiquidSelectionFloat')) &&
    html.includes('landLiquidSelectionFloat(float, clear, function()') &&
    html.includes('if (!event.isTrusted || !float || !float.isConnected) return') &&
    html.includes("float.classList.remove('liquid-selection-landing')"),
    'PC 浮起与移动并行，实际抵达目标后立即落地，同位置点击不再补齐空行程等待');
  check(/\.conversation-selection-float\.liquid-selection-landing > \.conversation-drag-content\s*\{[^}]*scale\(calc\(1 \/ \.86\)\)/s.test(html) &&
    html.indexOf('stopLiquidMotionTracking(float);', html.indexOf('function landLiquidSelectionFloat')) <
      html.indexOf("float.classList.add('liquid-selection-landing')", html.indexOf('function landLiquidSelectionFloat')),
    'PC 对话落地只收缩光学外壳，携带文字图标保持原尺寸且不继承速度形变');
  const menuPointerUp = html.slice(html.indexOf('function onPointerUp(event)', html.indexOf('function wireLiquidMenuInteractions(menu)')), html.indexOf('function onPointerCancel(event)', html.indexOf('function wireLiquidMenuInteractions(menu)')));
  const railPointerUp = html.slice(html.indexOf('function onPointerUp(event)', html.indexOf('function wireLiquidRailInteractions(container, selector)')), html.indexOf('function onPointerCancel(event)', html.indexOf('function wireLiquidRailInteractions(container, selector)')));
  check(menuPointerUp.indexOf('position(commit)') >= 0 &&
    menuPointerUp.indexOf('landLiquidSelectionFloat') < menuPointerUp.indexOf('commit.click()') &&
    railPointerUp.indexOf('position(commit)') >= 0 &&
    railPointerUp.indexOf('landLiquidSelectionFloat') < railPointerUp.indexOf('commit.click()'),
    'PC 弹窗/栏轨在完整移动落地后才派发命令，弹窗和页面不会提前卸载');
  check(/\.model-select-menu-option::after,[\s\S]*\.mode-toggle-btn\[data-mode\]::after,[\s\S]*\.memory-lab-view-menu button\[data-memory-view\]::after\s*\{[^}]*display:\s*none\s*!important/s.test(html),
    '统一移动选择控件禁用按钮自身伪玻璃，交互期间始终只有一个浮块');
  check(html.includes('document.elementFromPoint(event.clientX, event.clientY)') &&
    !html.includes('float.innerHTML = source.innerHTML'),
    'pointer capture 后按坐标命中目标行，普通浮块不复制内部内容');
  check(html.includes('function wireLiquidRailInteractions(container, selector)') &&
    html.includes("wireLiquidRailInteractions(document.getElementById('left-ws-list'), '.left-ws-item')") &&
    html.includes("wireLiquidRailInteractions(document.getElementById('right-tabs'), '.tab-btn[data-tab]')") &&
    html.includes("wireLiquidRailInteractions(container, '.left-ws-item')"),
    'PC 左右侧栏接入同款拖动浮起玻璃块');
  check(html.includes("wireLiquidRailInteractions(document.querySelector('.settings-tabs:not(.plugin-tabs)'), '.stab-btn[data-stab]')"),
    'PC 设置浮窗横向分页接入拖动浮起玻璃');
  check(/\.settings-tabs\s*\{[^}]*border-radius:\s*var\(--radius-full\)[^}]*background:\s*var\(--glass-bg-1\)/s.test(html),
    'PC 设置与插件分页使用连续胶囊轨道');
  check(/\.settings-tabs::-webkit-scrollbar\s*\{\s*display:\s*none/.test(html),
    'PC 连续胶囊分页在窄窗口可滚动但不显示扩展滚动条');
  check(html.includes("wireLiquidRailInteractions(document.querySelector('.plugin-tabs[role=\"tablist\"]'), '.stab-btn[data-plugin-tab]')") &&
    html.includes("wireLiquidRailInteractions(panel.querySelector('.memory-lab-view-menu'), 'button[data-memory-view]')"),
    'PC 插件子分页与 MemoryLab 总览/详细接入唯一浮起玻璃滑动');
  check(html.includes("wireLiquidRailInteractions(document.querySelector('.workspace-type-pager'), '.workspace-type-option')") &&
    /workspace-type-pager[\s\S]*grid-template-columns:\s*repeat\(3/s.test(html) && html.includes('role="radiogroup"'),
    'PC 新建工作区三单选改为连续横向胶囊拖动分页器');
  check(html.includes("wireLiquidRailInteractions(document.getElementById('mode-toggle'), '.mode-toggle-btn[data-mode]')") &&
    /\.mode-toggle\s*\{[^}]*border-radius:\s*var\(--radius-full\)[^}]*position:\s*relative/s.test(html),
    'PC Guide/Next 接入横向拖动浮起玻璃滑块');
  check(html.includes('function keepLiquidFloatExpansionInsideViewport(float, rect)') && html.includes("? 'left center'") && html.includes("? 'right center'"),
    'PC 靠窗浮块只向窗口内侧放大，不再越界造成屏外飞入错觉');
  check(doc.getElementById('left-ws-section')?.parentElement?.id === 'left-content' &&
    doc.getElementById('left-tool-surface')?.nextElementSibling?.id === 'left-ws-section',
    'PC 工具区与工作区保持同级，工具浮层不会下推工作区');
  check(/#left-tool-surface\s*\{[^}]*display:\s*contents/s.test(html) &&
    !/#left-tool-surface\s*\{[^}]*flex:/s.test(html),
    'PC 工具手势容器不生成布局盒，工作区恢复原始纵向位置');
  check(!/#left-ws-list,\s*#right-tabs,\s*#left-thumb\s*\{\s*position:\s*relative/s.test(html) &&
    /#left-thumb\s*\{[^}]*position:\s*absolute/s.test(html),
    'PC 折叠工具层保持 absolute，不再占据一半左栏高度');
  check(html.includes('function mountLiquidViewportFloat(float)') &&
    html.includes("float.setAttribute('popover', 'manual')") &&
    html.includes('function showLiquidViewportFloat(float)') &&
    /mountLiquidViewportFloat\(float\);[\s\S]*?position\(source\);\s*showLiquidViewportFloat\(float\);/s.test(html) &&
    /liquid-selection-viewport\s*\{\s*position:\s*fixed/.test(html),
    'PC 菜单/弹窗/左栏浮块使用 top-layer viewport 层，不受 overflow 裁剪');
  check(/liquid-selection-viewport\s*\{[^}]*inset:\s*auto/s.test(html) &&
    html.includes("float.className = 'liquid-selection-float liquid-selection-primed'") &&
    /showLiquidViewportFloat\(float\);\s*position\(source\);\s*float\.getBoundingClientRect\(\)/s.test(html) &&
    html.includes("float.classList.remove('liquid-selection-primed')"),
    'PC top-layer 提升期间禁用过渡并二次锁定源坐标，不从窗口外飞入');
  check(html.includes('window.setLiquidSidebarGestureLock') &&
    html.includes("window.setLiquidSidebarGestureLock('popup:model-select', true)") &&
    html.includes("window.setLiquidSidebarGestureLock('conversation-reorder', true)"),
    '弹窗与对话排序期间禁用侧栏滑动/调整手势');
  check(/#right\s*\{[^}]*border-radius:\s*var\(--radius-lg\) 0 0 var\(--radius-lg\)/s.test(html) &&
    /#right\.open\s*\{[^}]*box-shadow:\s*none/s.test(html),
    '右侧栏左上/左下圆角且取消左侧泛光');
  check(/\.msg-action-btn::after,[\s\S]*button\.conversation-work-run-head::after,[\s\S]*button\.shell-block-header::after,[\s\S]*button\.diff-block-header::after,[\s\S]*button\.work-review-head::after\s*\{\s*display:\s*none/s.test(html) &&
    /button\.conversation-work-run-head:active:not\(:disabled\),[\s\S]*button\.work-review-head:active:not\(:disabled\)\s*\{[\s\S]*scale:\s*1;[\s\S]*filter:\s*none/s.test(html),
    '复制/编辑以及 Build/block/tool/review 展开按钮不生成玻璃板或按压缩放');
  check(/\.conversation-work-run-head\s*\{[^}]*transition:\s*none\s*!important[^}]*animation:\s*none\s*!important/s.test(html) &&
    /\.conversation-work-run-head:hover\s*\{[^}]*filter:\s*none/s.test(html) &&
    /\.conversation-work-run-chevron\s*\{[^}]*transition:\s*none/s.test(html),
    'Build 历史展开是无玻璃、无过渡、无亮度动效的即时披露');
  check(html.includes("head.querySelector('.conversation-work-change-badge')") &&
    !html.includes("head.querySelector('.conversation-work-run-change-badge')"),
    'Build 增量刷新复用唯一文件审查徽标，不因展开重复插入');
  check(html.includes("input.classList.add('liquid-switch-dragging')") &&
    html.includes("input.style.setProperty('--liquid-switch-x'") &&
    html.includes("input.style.setProperty('--liquid-switch-progress'") &&
    /liquid-switch-dragging::before\s*\{[^}]*width:\s*22px[^}]*scale\(1\.22\)/s.test(html) &&
    html.includes('var next = dragging ? fraction >= 0.5 : !input.checked') &&
    html.includes('Math.hypot(deltaX, deltaY) < dragThreshold') &&
    html.includes('if (!commit || canceledToScroll) return') &&
    html.indexOf("input.dataset.liquidSuppressClick = 'true'") < html.indexOf('function update(clientX)'),
    'PC 开关点击直接反转；仅水平越过阈值后跟手并按松手档位吸附');
  check(/\.left-ws-item\s*\{[^}]*border-radius:\s*var\(--radius-full\)/s.test(html) &&
    /\.left-ws-item \.ws-icon\s*\{[^}]*border-radius:\s*50%/s.test(html) &&
    /\.conv-item\s*\{[^}]*border-radius:\s*var\(--radius-full\)/s.test(html),
    'PC 工作区与二级对话为胶囊，工作区缩略图为圆形');
  check(html.includes("list.insertBefore(dragging, anchor)") &&
    html.includes('window.commitConversationDomOrder = function()') &&
    html.includes('event.dataTransfer.setDragImage(transparentDragImage, 0, 0)') &&
    html.includes("float.className = 'liquid-selection-float conversation-selection-float liquid-selection-primed'") &&
    html.includes('attachKyantLiquidRenderer(float, frame)') &&
    html.includes('positionConversationGlassAroundRow(float, row)') &&
    html.includes('wrapConversationDragContent(target, float)') &&
    html.includes("float.classList.add('conversation-drag-following')") &&
    html.includes('window.updateConversationNativeDrag(event.clientX, event.clientY)') &&
    html.includes("list.dataset.conversationDropWired = 'true'") &&
    html.includes('window.cancelConversationGlassFlight = function()') &&
    html.includes("window.animateConversationGlassTo(this, { dragging: true })") &&
    html.includes("list.classList.add('conversation-reordering')") &&
    html.includes("list.classList.remove('conversation-reordering')") &&
    html.includes("window.animateConversationGlassTo(releasedRow, { onArrive: function()") &&
    /#conversation-list\.conversation-reordering \.conv-item\.active:not\(\.conversation-glass-dragging\)/.test(html) &&
    !html.includes("this.classList.add('drag-over')"),
    'PC 对话拖动仅保留携带胶囊，其余行直接换位避让且不显示第二个选中/落点胶囊');
  check(html.includes("input.classList.add('liquid-range-dragging')") &&
    html.includes("input.style.setProperty('--liquid-range-progress'") &&
    html.includes("input.dispatchEvent(new Event('input', { bubbles: true }))") &&
    html.includes("input.dispatchEvent(new Event('change', { bubbles: true }))") &&
    /liquid-range-dragging::-webkit-slider-thumb\s*\{[^}]*width:\s*26px[^}]*border-radius:\s*var\(--radius-full\)[^}]*scale\(1\.22\)/s.test(html),
    '玻璃强度滑条按住浮起为玻璃胶囊、实时跟手预览并在松手提交');
  check(html.includes('window.animateConversationGlassTo') &&
    html.includes('var conversationGlassFlight = { float: null, source: null, covered: null, timer: 0, generation: 0 }') &&
    html.includes('var redirecting = !!(float && float.isConnected)') &&
    html.includes('if (conversationGlassFlight.timer) clearTimeout(conversationGlassFlight.timer)') &&
    html.includes('if (conversationGlassFlight.generation !== generation) return') &&
    html.includes('float.getBoundingClientRect()') &&
    html.includes('if (!row || !conversations[idx])') &&
    html.includes('wrapConversationDragContent(target, float)') &&
    html.includes("source.classList.add('liquid-selection-source')") &&
    html.includes('window.activateConversationWithGlass'),
    'PC 对话同项点击完整起落、连续点击复用新版色散浮块，排序抵达后包裹真实拖动行');
  const activateConversationBlock = html.slice(html.indexOf('window.activateConversationWithGlass = function'), html.indexOf('function renderConversations()', html.indexOf('window.activateConversationWithGlass = function')));
  check(/\.liquid-selection-source\s*\{[^}]*border-color:\s*transparent\s*!important/s.test(html) &&
    html.includes('.conv-item.liquid-selection-covered { border-color: transparent !important; }') &&
    html.includes('.conv-item.liquid-selection-covered.marquee-border::before { opacity: 0 !important; }') &&
    html.includes("row.classList.add('liquid-selection-covered')") &&
    activateConversationBlock.indexOf('window.animateConversationGlassTo(row, { onArrive: function()') < activateConversationBlock.indexOf('window.switchConversation(targetIndex)') &&
    !/window\.animateConversationGlassTo\(row\);\s*window\.switchConversation\(idx\)/.test(activateConversationBlock),
    'PC 对话浮块覆盖时关闭静态/动态边框，并在最终落地后才切换对话页面');
  check(/#000 0deg, #fff 90deg, #000 180deg, #fff 270deg, #000 360deg/.test(html), '运行光效为连续黑白黑白边框渐变');
  check(html.includes('--settings-modal-surface: rgba(255,255,255,0.94);') &&
    html.includes("classList.toggle('settings-window'") &&
    /\[data-theme="light"\] \.sub-win\.liquid-glass-carrier\s*\{[^}]*var\(--settings-modal-surface\)/s.test(html) &&
    !html.includes('0 0 42px rgba(255,255,255,0.72)'),
    'PC 左侧工具栏打开的全部 sub-window 与设置弹窗共享亮色本底并保留单层玻璃壳');
  check((html.match(/window\.addEventListener\('pointermove', onPointerMove, true\)/g) || []).length >= 2 &&
    html.includes("window.removeEventListener('pointermove', onPointerMove, true)") &&
    html.includes("document.addEventListener('dragover', function(event)") &&
    html.includes("div.addEventListener('drag', function(event)"),
    'PC 按住浮块后由窗口级 pointer capture 与文档级 native drag 持续追踪区域外指针');

  console.log('pcGlassMigrationVerify: all checks passed');
}

function extractRule(html: string, selector: string): string {
  const lines = html.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === selector + ' {');
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth <= 0) return lines.slice(start, i + 1).join('\n');
  }
  return '';
}

main();
