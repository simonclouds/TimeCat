import { TPL, pacmanCss } from './tpl'
import { getDBOperator } from './store/idb'
import { isDev, classifyRecords, download, getRandomCode, getTime, isVNode } from './tools/common'
import pako from 'pako'
import { SnapshotData } from '@TimeCat/snapshot'
import { RecordData, AudioData, RecorderOptions, NONERecord, RecordType } from '@TimeCat/record'
import { base64ToFloat32Array, encodeWAV } from './transform'
import { getScript } from './tools/dom'
import { recoverNative } from './tools/recover-native'
import { VNode, VSNode } from '@TimeCat/virtual-dom'
import { nodeStore } from './store/node'

type ScriptItem = { name?: string; src: string }
type ExportOptions = { scripts?: ScriptItem[]; autoplay?: boolean; audioExternal?: boolean; dataExternal?: boolean }

const EXPORT_NAME_LABEL = 'TimeCat'
const downloadAudioConfig = {
    extractAudioDataList: [] as {
        source: string[]
        fileName: string
    }[],
    opts: {} as RecorderOptions
}

export async function exportReplay(exportOptions: ExportOptions) {
    recoveryMethods()
    await addNoneFrame()
    const parser = new DOMParser()
    const html = parser.parseFromString(TPL, 'text/html')
    await injectData(html, exportOptions)
    await initOptions(html, exportOptions)
    downloadFiles(html)
}

function recoveryMethods() {
    const methods = [
        // 'HTMLElement.prototype.insertBefore',
        // 'HTMLElement.prototype.append',
        'HTMLElement.prototype.appendChild'
    ]

    methods.forEach(recoverNative.recoverMethod.bind(recoverNative))
}

async function addNoneFrame() {
    const DBOperator = await getDBOperator
    DBOperator.add({
        type: 'NONE',
        data: null,
        time: getTime().toString()
    } as NONERecord)
}

function downloadHTML(content: string) {
    const blob = new Blob([content], { type: 'text/html' })
    download(blob, `${EXPORT_NAME_LABEL}-${getRandomCode()}.html`)
}

function downloadFiles(html: Document) {
    downloadHTML(html.documentElement.outerHTML)
    downloadAudios()
}

function downloadAudios() {
    if (window.__ReplayData__) {
        const replayData = window.__ReplayData__
        if (replayData.audio) {
            const { src } = replayData.audio
            download(src, src)
            return
        }
    }

    downloadAudioConfig.extractAudioDataList.forEach(extractedData => {
        const floatArray = extractedData.source.map(data => base64ToFloat32Array(data))
        const audioBlob = encodeWAV(floatArray, downloadAudioConfig.opts)
        download(audioBlob, extractedData.fileName)
    })

    downloadAudioConfig.extractAudioDataList.length = 0
}

async function initOptions(html: Document, exportOptions: ExportOptions) {
    const { scripts, autoplay } = exportOptions
    const options = { autoplay }
    const scriptList = scripts || ([] as ScriptItem[])

    if (!scriptList.some(item => item.name === 'time-cat-init')) {
        scriptList.push({
            name: 'time-cat-init',
            src: `timecat.replay(${JSON.stringify(options)})`
        })
    }

    await injectScripts(html, scriptList)
}

async function injectScripts(html: Document, scripts?: ScriptItem[]) {
    if (scripts) {
        for (let scriptItem of scripts) {
            const { src, name } = scriptItem
            let scriptContent = src
            const script = document.createElement('script')
            if (name) {
                script.id = name
            }
            const isUrlReg = /^(chrome-extension|https?):\/\/.+/
            // is a link or script text
            if (isUrlReg.test(src)) {
                if (isDev) {
                    script.src = src
                } else {
                    scriptContent = await getScript(src)
                }
            }
            script.text = scriptContent
            html.body.appendChild(script)
        }
    }
}

async function getDataFromDB(exportOptions?: ExportOptions) {
    const DBOperator = await getDBOperator
    const data = await DBOperator.readAllRecords()
    const classified = classifyRecords(data)
    return extract(classified, exportOptions)
}

function extract(
    replayDataList: { snapshot: SnapshotData; records: RecordData[]; audio: AudioData }[],
    exportOptions?: ExportOptions
) {
    return replayDataList.map(replayData => {
        if (exportOptions && exportOptions.audioExternal) {
            replayData.audio = extractAudio(replayData.audio)
        }
        return replayData
    })
}

function extractAudio(audio: AudioData) {
    const source = audio.bufferStrList.slice()
    if (!source.length) {
        return audio
    }

    const fileName = `${EXPORT_NAME_LABEL}-audio-${getRandomCode()}.wav`
    downloadAudioConfig.extractAudioDataList.push({
        source,
        fileName
    })
    downloadAudioConfig.opts = audio.opts
    audio.src = fileName
    audio.bufferStrList.length = 0
    return audio
}

async function injectData(html: Document, exportOptions: ExportOptions) {
    const data = window.__ReplayDataList__ || (await getDataFromDB(exportOptions))

    const extractedData = await makeCssInline(data) // some link cross origin

    const jsonStrData = JSON.stringify(extractedData)

    const zipArray = pako.gzip(jsonStrData)
    let outputStr: string = ''

    for (let i = 0; i < zipArray.length; i++) {
        let num = zipArray[i]

        if (~[13, 34, 39, 44, 60, 62, 92, 96, 10, 0].indexOf(num)) {
            num += 300
        }

        outputStr += String.fromCharCode(num)
    }

    const replayData = `var __ReplayStrData__ =  '${outputStr}'`
    const loadingScriptContent = `const loadingNode = document.createElement('div')
    loadingNode.className = 'pacman-box';
    loadingNode.innerHTML = '<style>${pacmanCss}<\/style><div class="pacman"><div><\/div><div><\/div><div><\/div><div><\/div><div><\/div><\/div>'
    loadingNode.setAttribute('style', 'text-align: center;vertical-align: middle;line-height: 100vh;')
    document.body.insertBefore(loadingNode, document.body.firstChild);window.addEventListener('DOMContentLoaded', () => loadingNode.parentNode.removeChild(loadingNode))`
    injectScripts(html, [{ src: loadingScriptContent }])
    injectScripts(html, [{ src: replayData }])
}

async function makeCssInline(dataList: { snapshot: SnapshotData; records: RecordData[]; audio: AudioData }[]) {
    const extractLinkList: VNode[] = []

    for (let k = 0; k < dataList.length; k++) {
        const data = dataList[k]
        const { snapshot, records } = data
        const tasks = [snapshot.vNode]
        let node
        while ((node = tasks.shift())) {
            if (isVNode(node)) {
                extractLink(node, extractLinkList)
                tasks.push(...(node.children as VNode[]))
            }
        }

        for (let i = 0; i < records.length; i++) {
            const record = records[i]
            if (record.type === 'DOM_UPDATE') {
                const { addedNodes } = record.data
                for (let j = 0; j < addedNodes.length; j++) {
                    const node = addedNodes[j].node
                    if (isVNode(node as VNode)) {
                        extractLink(node as VNode, extractLinkList)
                    }
                }
            }
        }
    }

    for (const node of extractLinkList) {
        const { attrs } = node
        const href = attrs.href

        try {
            // try to extract css
            const cssValue = await fetch(href).then(res => res.text())
            const textNode = {
                id: nodeStore.createNodeId(),
                type: Node.TEXT_NODE,
                value: cssValue
            } as VSNode

            delete attrs.href
            node.tag = 'style'

            node.children.push(textNode)
        } catch (error) {
            // maybe cross
        }
    }
    return dataList
}

function extractLink(node: VNode, extractLinkList: VNode[]) {
    const { tag, attrs } = node
    if (tag === 'link' && attrs.href && attrs.href.endsWith('.css')) {
        extractLinkList.push(node)
    }
}
