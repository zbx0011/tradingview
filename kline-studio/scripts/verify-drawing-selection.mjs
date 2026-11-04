import assert from 'node:assert/strict'
import { chromium } from 'file:///C:/Users/zbx00/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'

// Disposable browser and isolated component harness: never opens saved user storage.
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || 'C:/Users/zbx00/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe' })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  const source = await (await page.request.get('http://127.0.0.1:4173/src/components/DrawingOverlay.tsx')).text()
  const reactUrl = source.match(/"([^"\n]*\/react\.js\?v=[^"]+)"/)[1]
  const main = await (await page.request.get('http://127.0.0.1:4173/src/main.tsx')).text()
  const reactDomUrl = main.match(/"([^"\n]*\/react-dom_client\.js\?v=[^"]+)"/)[1]
  await page.route('**/drawing-selection-test', route => route.fulfill({ contentType: 'text/html', body: `
    <div id="root"></div><style>body{margin:0}svg{width:1000px;height:700px}</style>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const {default: React} = await import('${reactUrl}');
      const {default: ReactDOM} = await import('${reactDomUrl}');
      const {DrawingOverlay} = await import('/src/components/DrawingOverlay.tsx');
      const {drawingReducer} = await import('/src/lib/drawings.ts');
      function Harness() {
        const [history, dispatch] = React.useReducer(drawingReducer, {past:[],future:[],selectedId:null,selectedIds:[],present:[
          {id:'channel',tool:'parallel-channel',behavior:'channel',label:'channel',points:[{x:.2,y:.7},{x:.6,y:.3}],color:'#90bfff',width:2}
          ,{id:'rectangle',tool:'rectangle',behavior:'rectangle',label:'rectangle',points:[{x:.7,y:.1},{x:.9,y:.3}],color:'#90bfff',width:2}
        ]});
        window.drawingHistory = history;
        window.dispatchDrawing = dispatch;
        return React.createElement(DrawingOverlay, {activeTool:'cursor',history,dispatch,color:'#90bfff',magnetMode:'off',drawingsLocked:false,hidden:false,candles:[],symbol:'XAUUSD',interval:'5m',quickMeasurement:null,onMeasurePoint:()=>null,onProjectPoint:()=>null,onQuickMeasurementChange:()=>{},onToolComplete:()=>{},onZoomSelection:()=>{},onOpenProperties:()=>{}});
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script>` }))
  await page.goto('http://127.0.0.1:4173/drawing-selection-test')
  const drawing = page.locator('[data-behavior="channel"]')
  await drawing.waitFor()
  await page.waitForFunction(() => document.querySelector('svg')?.getAttribute('viewBox') === '0 0 1000 700')
  const hit = await drawing.locator('line').first().evaluate(line => ({
    x: Number(line.getAttribute('x1')) * .75 + Number(line.getAttribute('x2')) * .25,
    y: Number(line.getAttribute('y1')) * .75 + Number(line.getAttribute('y2')) * .25,
  }))
  await page.mouse.click(hit.x, hit.y)
  assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), 'channel', 'selection must survive mouse release')
  assert.match(await drawing.getAttribute('class'), /selected/)
  await page.mouse.click(hit.x, hit.y)
  assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), 'channel', 'second click must preserve selection')
  await page.keyboard.down('Control')
  await page.mouse.click(hit.x, hit.y)
  await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), null, 'Ctrl click toggles selection off')
  await page.keyboard.down('Control')
  await page.mouse.click(hit.x, hit.y)
  await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), 'channel', 'Ctrl click toggles selection on')
  const before = await page.evaluate(() => window.drawingHistory.present[0].points[0].x)
  await page.mouse.move(hit.x, hit.y)
  await page.mouse.down()
  await page.mouse.move(hit.x + 50, hit.y + 20, {steps:5})
  await page.mouse.up()
  assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), 'channel', 'drag must preserve selection')
  assert.ok((await page.evaluate(() => window.drawingHistory.present[0].points[0].x)) > before, 'drag must move drawing')
  const centerline = await page.evaluate(() => window.drawingHistory.present[0].points)
  for (const [side, delta] of [['upper', -45], ['lower', -25]]) {
    const handle = drawing.locator(`[data-channel-width="${side}"]`)
    const box = await handle.boundingBox()
    const oldWidth = await page.evaluate(() => window.drawingHistory.present[0].channelWidth?.normalized)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + delta, {steps:5})
    await page.mouse.up()
    assert.deepEqual(await page.evaluate(() => window.drawingHistory.present[0].points), centerline, 'width adjustment must preserve centerline')
    const newWidth = await page.evaluate(() => window.drawingHistory.present[0].channelWidth.normalized)
    assert.ok(newWidth > 0 && newWidth !== oldWidth, 'both boundaries must resize width')
    assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), 'channel')
  }
  for (const delta of [80, -120]) {
    const grip = await drawing.locator('[data-channel-move="center"]').boundingBox()
    const original = await page.evaluate(() => window.drawingHistory.present[0])
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2 + delta, grip.y + grip.height / 2, {steps:5})
    await page.mouse.up()
    const moved = await page.evaluate(() => window.drawingHistory.present[0])
    for (let i = 0; i < original.points.length; i++) {
      assert.ok(Math.abs(moved.points[i].x - original.points[i].x - delta / 1000) < 1e-6, 'center grip translates both endpoints horizontally')
      assert.equal(moved.points[i].y, original.points[i].y, 'horizontal movement preserves price height')
    }
    assert.deepEqual(moved.channelWidth, original.channelWidth, 'horizontal movement preserves channel width')
  }
  const rectangle = page.locator('[data-behavior="rectangle"]')
  await page.evaluate(() => window.dispatchDrawing({type:'select',id:'rectangle'}))
  await rectangle.waitFor()
  await rectangle.locator('[data-drawing-anchor="nw"]').waitFor()
  assert.equal(await rectangle.locator('[data-drawing-anchor]').count(), 8, 'rectangle must expose four corner and four edge resize handles')
  const rectangleBefore = await page.evaluate(() => window.drawingHistory.present.find(item => item.id === 'rectangle').points)
  const rectangleHandle = await rectangle.locator('[data-drawing-anchor="nw"]').boundingBox()
  await page.mouse.move(rectangleHandle.x + rectangleHandle.width / 2, rectangleHandle.y + rectangleHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(rectangleHandle.x + rectangleHandle.width / 2 - 40, rectangleHandle.y + rectangleHandle.height / 2 - 30, {steps:5})
  await page.mouse.up()
  const rectangleAfter = await page.evaluate(() => window.drawingHistory.present.find(item => item.id === 'rectangle').points)
  assert.deepEqual(rectangleAfter[1], rectangleBefore[1], 'rectangle opposite corner must remain fixed')
  assert.ok(rectangleAfter[0].x < rectangleBefore[0].x && rectangleAfter[0].y < rectangleBefore[0].y, 'rectangle corner drag must resize both width and height')
  const edgeBefore = await page.evaluate(() => window.drawingHistory.present.find(item => item.id === 'rectangle').points)
  const edgeHandle = await rectangle.locator('[data-drawing-anchor="e"]').boundingBox()
  await page.mouse.move(edgeHandle.x + edgeHandle.width / 2, edgeHandle.y + edgeHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(edgeHandle.x + edgeHandle.width / 2 + 35, edgeHandle.y + edgeHandle.height / 2, {steps:5})
  await page.mouse.up()
  const edgeAfter = await page.evaluate(() => window.drawingHistory.present.find(item => item.id === 'rectangle').points)
  assert.equal(edgeAfter[0].y, edgeBefore[0].y, 'rectangle edge drag must preserve top/bottom')
  assert.equal(edgeAfter[1].y, edgeBefore[1].y, 'rectangle edge drag must preserve top/bottom')
  assert.ok(edgeAfter[0].x > edgeBefore[0].x || edgeAfter[1].x > edgeBefore[1].x, 'rectangle edge drag must resize width')
  // Exercise the genuine blank-canvas click handler independently of CSS hit testing.
  await page.evaluate(() => window.dispatchDrawing({type:'select',id:'channel'}))
  await page.evaluate(() => window.dispatchDrawing({type:'update',id:'channel',patch:{tool:'trend-line',behavior:'line'}}))
  await page.waitForFunction(() => document.querySelector('[data-testid="drawing-object"]')?.getAttribute('data-behavior') === 'line')
  const lineDrawing = page.locator('[data-behavior="line"]')
  await lineDrawing.locator('[data-drawing-anchor="start"]').waitFor()
  for (const [anchor, index] of [['start', 0], ['end', 1]]) {
    const original = await page.evaluate(() => window.drawingHistory.present[0].points)
    const handle = await lineDrawing.locator(`[data-drawing-anchor="${anchor}"]`).boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + 35, handle.y + handle.height / 2 - 28, {steps:5})
    await page.mouse.up()
    const points = await page.evaluate(() => window.drawingHistory.present[0].points)
    assert.deepEqual(points[1-index], original[1-index], 'opposite endpoint must remain fixed')
    assert.ok(Math.abs(points[index].x - original[index].x - .035) < 1e-6, 'dragged endpoint moves horizontally')
    assert.ok(Math.abs(points[index].y - original[index].y + .04) < 1e-6, 'dragged endpoint moves vertically')
    assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), 'channel')
  }
  await page.locator('svg').dispatchEvent('click')
  assert.equal(await page.evaluate(() => window.drawingHistory.selectedId), null, 'subsequent blank click must still deselect')
  assert.deepEqual(errors, [])
  console.log('PASS: selection, channel movement/width, independent line start/end dragging, rectangle corner resize, blank deselection')
} finally {
  await browser.close()
}
