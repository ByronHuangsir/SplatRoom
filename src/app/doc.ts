import { ZipFileSystem, ZipReadFileSystem } from '@playcanvas/splat-transform';

import { recentFiles } from './recent-files';
import { AnimationController } from '../animation/animation-controller';
import { Events } from '../core/events';
import { BrowserFileSystem, BlobReadSource } from '../io/index';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';
import { writeSplatFile } from '../splat/splat-serialize';
import { Transform } from '../transform/transform';
import { i18n } from '../ui/localization';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

const SuperFileType: FilePickerAcceptType[] = [{
    description: 'SplatRoom document',
    accept: {
        'application/x-splatroom': ['.ssproj']
    }
}];

type FileSelectorCallback = (fileList: File) => void;

// helper class to show a file selector dialog.
// used when showOpenFilePicker is not available.
class FileSelector {
    show: (callbackFunc: FileSelectorCallback) => void;

    constructor() {
        const fileSelector = document.createElement('input');
        fileSelector.setAttribute('id', 'document-file-selector');
        fileSelector.setAttribute('type', 'file');
        fileSelector.setAttribute('accept', '.ssproj');
        fileSelector.setAttribute('multiple', 'false');

        document.body.append(fileSelector);

        let callbackFunc: FileSelectorCallback = null;

        fileSelector.addEventListener('change', () => {
            callbackFunc(fileSelector.files[0]);
            // 重置 value：否则再次选择同一文件不会触发 change
            fileSelector.value = '';
        });

        fileSelector.addEventListener('cancel', () => {
            callbackFunc(null);
        });

        this.show = (func: FileSelectorCallback) => {
            callbackFunc = func;
            fileSelector.click();
        };
    }
}

const registerDocEvents = (scene: Scene, events: Events) => {
    // construct the file selector
    const fileSelector = window.showOpenFilePicker ? null : new FileSelector();

    // this file handle is updated as the current document is loaded and saved
    let documentFileHandle: FileSystemFileHandle = null;

    // show the user a reset confirmation popup
    const getResetConfirmation = async () => {
        const result = await events.invoke('showPopup', {
            type: 'yesno',
            header: i18n.t('doc.reset'),
            message: i18n.t(events.invoke('scene.dirty') ? 'doc.unsaved-message' : 'doc.reset-message')
        });

        if (result.action !== 'yes') {
            return false;
        }

        return true;
    };

    // reset the scene
    const resetScene = () => {
        events.fire('scene.clear');
        events.fire('camera.reset');
        events.fire('doc.setName', null);
        documentFileHandle = null;
    };

    // load the document from the given file. Returns true only on success:
    // a failed load leaves the scene reset but must NOT bind the file handle,
    // otherwise a subsequent Ctrl+S would overwrite the user's original file
    // with the empty scene.
    const loadDocument = async (file: Blob): Promise<boolean> => {
        events.fire('startSpinner');

        // Create streaming ZIP reader from the file
        const blobSource = new BlobReadSource(file);
        const zipFs = new ZipReadFileSystem(blobSource);

        try {
            // the document's view settings are applied through the same events
            // as user changes - suspend preference capture so they don't
            // overwrite the user's stored preferences. resumed in the finally
            // below so a failed load can't leave capture suspended.
            events.fire('preferences.suspend');

            // reset the scene
            resetScene();

            // read document.json via streaming (only reads what's needed)
            const docSource = await zipFs.createSource('document.json');
            const docData = await docSource.read().readAll();
            docSource.close();
            const document = JSON.parse(new TextDecoder().decode(docData));

            // run through each splat and load it
            let loadedSplats = 0;
            for (let i = 0; i < document.splats.length; ++i) {
                const filename = `splat_${i}.ply`;
                const splatSettings = document.splats[i];

                // load splat directly from the zip filesystem (streams on-demand)
                // skipReorder=true because ssproj PLY files are already in morton order
                // One retry: GPU fenceSync readbacks (WebGL clientWaitSync) can fail
                // transiently under load on some drivers; a single immediate retry
                // recovers most of those without losing the whole document.
                let splat: Splat | null = null;
                const MISSING_PLY = 'Entry not found';
                try {
                    splat = await scene.assetLoader.load(filename, zipFs, false, true);
                } catch (firstErr) {
                    const firstMsg = (firstErr as Error)?.message ?? String(firstErr);
                    // A splat whose gaussians were all deleted has no PLY in
                    // the archive — skip silently instead of retrying + logging
                    // errors on every document open.
                    if (firstMsg.includes(MISSING_PLY)) {
                        continue;
                    }
                    console.warn(`[doc.load] splat ${i} load failed (${firstMsg}), retrying once`);
                    try {
                        splat = await scene.assetLoader.load(filename, zipFs, false, true);
                    } catch (secondErr) {
                        // A single splat failing must not abort the whole
                        // document — skip it and continue with the rest.
                        console.error(`[doc.load] splat ${i} load failed after retry:`, secondErr);
                        continue;
                    }
                }

                await scene.add(splat);
                loadedSplats++;

                splat.docDeserialize(splatSettings);
            }

            // 文档里记着 splat、但一个都没加载出来 ⇒ **必须报失败**。
            // 否则：空场景 + 报成功 + 调用方绑定文件句柄 + 名字设上；接着用户按 Ctrl+S，
            // 那份空文档就覆盖掉了原档案 —— 正是本文件上面那条注释想防的事。
            // 走到这里的现实路径：所有高斯都被删掉后保存（`writeSplatFile` 在没有可导出的行时
            // 不写任何 PLY 条目），于是打开时每个 splat 都落到上面的 `MISSING_PLY` 静默跳过。
            if (document.splats.length > 0 && loadedSplats === 0) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('doc.load-failed'),
                    message: `'${document.splats.length} 个 splat 的 PLY 都没能在档案里找到（通常是"高斯全部被删除后保存"留下的空文档）'`
                });
                return false;
            }

            // FIXME: trigger scene bound calc in a better way
            const tmp = scene.bound;
            if (tmp === null) {
                console.error('this should never fire');
            }

            events.invoke('docDeserialize.timeline', document.timeline);
            events.invoke('docDeserialize.poseSets', document.poseSets, document.camera?.fov);
            events.invoke('docDeserialize.tracks', document.tracks);
            events.invoke('docDeserialize.view', document.view);
            scene.camera.docDeserialize(document.camera);

            // refresh the pivot to reflect the loaded transform
            const currentSelection = events.invoke('selection');
            if (currentSelection) {
                const pivot = events.invoke('pivot');
                const transform = new Transform();
                const pivotOrigin = events.invoke('pivot.origin');
                currentSelection.getPivot(pivotOrigin, false, transform);
                pivot.place(transform);
            }

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('doc.load-failed'),
                message: `'${error.message ?? error}'`
            });
            return false;
        } finally {
            // fire events before cleanup so a throwing close can't leave
            // preference capture suspended or the spinner running
            events.fire('preferences.resume');
            events.fire('stopSpinner');

            // Clean up resources
            zipFs.close();
        }
    };

    // 返回是否保存成功：失败时 fire doc.saved 会清空脏标记（scene.dirty），
    // 导致 Electron 关闭确认被绕过、未保存修改静默丢失。因此仅在成功时
    // 才允许调用方触发 doc.saved。
    const saveDocument = async (options: { stream?: FileSystemWritableFileStream, filename?: string }): Promise<boolean> => {
        events.fire('startSpinner');

        // 保存过程里创建的写入器：失败时必须在 catch 里收尾（下面解释为什么），所以放在 try 外面
        let saveWriter: { abort?: () => Promise<void> } | null = null;
        let saveZipFs: { abort?: () => Promise<void> } | null = null;

        try {
            const splats = events.invoke('scene.allSplats') as Splat[];

            const document = {
                version: 1,
                camera: scene.camera.docSerialize(),
                view: events.invoke('docSerialize.view'),
                poseSets: events.invoke('docSerialize.poseSets'),
                tracks: events.invoke('docSerialize.tracks'),
                timeline: events.invoke('docSerialize.timeline'),
                splats: splats.map(s => s.docSerialize())
            };

            const serializeSettings = {
                // even though we support saving selection state, we disable that for now
                // because including a uint8 array in the document PLY results in slow loading
                // path.
                keepStateData: false,
                keepWorldTransform: true,
                keepColorTint: true
            };

            // Create browser filesystem and zip filesystem
            const browserFs = new BrowserFileSystem(options.filename, options.stream);
            const browserWriter = await browserFs.createWriter(options.filename);
            const zipFs = new ZipFileSystem(browserWriter);
            saveWriter = browserWriter as unknown as { abort?: () => Promise<void> };
            saveZipFs = zipFs as unknown as { abort?: () => Promise<void> };

            // Write document.json
            const docWriter = await zipFs.createWriter('document.json');
            await docWriter.write(new TextEncoder().encode(JSON.stringify(document)));
            await docWriter.close();

            // Write each splat as PLY
            for (let i = 0; i < splats.length; ++i) {
                await writeSplatFile([splats[i]], serializeSettings, 'ply', `splat_${i}.ply`, {}, zipFs);
            }

            // Close zip (also closes underlying browser writer)
            await zipFs.close();
            return true;
        } catch (error) {
            // NOTE: createWritable() replaces the file on disk as soon as
            // writing starts, so a failure here means the previous .ssproj is
            // already gone — warn the user explicitly.
            //
            // **收尾写入器**：原来失败路径只是弹窗，那条 `FileSystemWritableFileStream` 既不 close
            // 也不 abort ⇒ 文件句柄的写入槽位一直被占着，而弹窗恰恰在邀请用户"再存一次"，
            // 重试的 `createWritable()` 可能直接抛 `NoModificationAllowedError`（要重启应用才好）。
            // 下面两步都是 best-effort：`abort()` 会释放流锁，抛了也吞掉（本来就在失败路径上）。
            try {
                if (saveZipFs && typeof saveZipFs.abort === 'function') {
                    await saveZipFs.abort();
                } else if (saveWriter && typeof saveWriter.abort === 'function') {
                    // 上游的 ZipFileSystem 没有 abort()：直接中止底层写入器，目的只是释放流锁。
                    // zip 的中央目录没写完，这份档案本来就已损坏（弹窗里已经这么写了）。
                    await saveWriter.abort();
                }
            } catch (abortErr) {
                console.warn('[doc.save] 失败后收尾写入器出错（忽略）：', abortErr);
            }

            const permissionDenied = error instanceof Error && error.name === 'NotAllowedError';
            const message = permissionDenied ?
                i18n.t('doc.save-permission-denied') :
                `'${error.message ?? error}'\n\n${i18n.t('doc.save-file-corrupted')}`;
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('doc.save-failed'),
                message
            });
            return false;
        } finally {
            events.fire('stopSpinner');
        }
    };

    // handle user requesting a new document
    events.function('doc.new', async () => {
        if (!await getResetConfirmation()) {
            return false;
        }
        resetScene();
        // new documents start from the user's stored preferences rather than
        // whatever view state the previous document left behind
        events.fire('preferences.apply');
        return true;
    });

    // handle document file being dropped
    // NOTE: on chrome it's possible to get the FileSystemFileHandle from the DataTransferItem
    // (which would result in more seamless user experience), but this is not yet supported in
    // other browsers.
    events.function('doc.load', async (file: File | ArrayBuffer, handle?: FileSystemFileHandle) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        // URL-only loads arrive as an ArrayBuffer (see file-handler); the zip
        // reader needs a Blob.
        const blob = file instanceof ArrayBuffer ? new Blob([file]) : file;

        const ok = await loadDocument(blob);
        if (!ok) return false;

        events.fire('doc.setName', file instanceof ArrayBuffer ? 'scene.ssproj' : file.name);

        if (handle) {
            documentFileHandle = handle;
            recentFiles.add(handle);
        }
    });

    events.function('doc.open', async () => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        if (fileSelector) {
            fileSelector.show(async (file?: File) => {
                if (file) {
                    await loadDocument(file);
                }
            });
        } else {
            try {
                const fileHandles = await window.showOpenFilePicker({
                    id: 'SplatRoomDocumentOpen',
                    multiple: false,
                    types: SuperFileType
                });

                if (fileHandles?.length === 1) {
                    const fileHandle = fileHandles[0];

                    // only bind the file handle when the load actually
                    // succeeded (a failed load must not let Ctrl+S overwrite
                    // the original file with the empty scene)
                    const ok = await loadDocument(await fileHandle.getFile());
                    if (!ok) return;

                    // store file handle for subsequent saves
                    documentFileHandle = fileHandle;
                    events.fire('doc.setName', fileHandle.name);
                    recentFiles.add(fileHandle);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        }
    });

    events.function('doc.openRecent', async (fileHandle: FileSystemFileHandle) => {
        if (!events.invoke('scene.empty') && !await getResetConfirmation()) {
            return false;
        }

        try {
            if (await fileHandle.queryPermission({ mode: 'read' }) !== 'granted') {
                if (await fileHandle.requestPermission({ mode: 'read' }) !== 'granted') {
                    return false;
                }
            }

            const ok = await loadDocument(await fileHandle.getFile());
            if (!ok) return;

            // store file handle for subsequent saves
            documentFileHandle = fileHandle;
            events.fire('doc.setName', fileHandle.name);
            recentFiles.add(fileHandle);
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(error);
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error-loading'),
                    message: `${error.message ?? error}`
                });
            }
        }
    });

    events.function('doc.save', async () => {
        if (documentFileHandle) {
            try {
                const ok = await saveDocument({
                    stream: await documentFileHandle.createWritable()
                });
                if (ok) events.fire('doc.saved');
            } catch (error) {
                if (error.name !== 'AbortError') {
                    // NotAllowedError (permission revoked) must not be silent:
                    // the user believes the save worked and may close the
                    // window, losing the document.
                    if (error.name === 'NotAllowedError') {
                        await events.invoke('showPopup', {
                            type: 'error',
                            header: i18n.t('doc.save-failed'),
                            message: i18n.t('doc.save-permission-denied')
                        });
                    } else {
                        console.error(error);
                    }
                }
            }
        } else {
            await events.invoke('doc.saveAs');
        }
    });

    events.function('doc.saveAs', async () => {
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    id: 'SplatRoomDocumentSave',
                    types: SuperFileType,
                    suggestedName: 'scene.ssproj'
                });
                const ok = await saveDocument({ stream: await handle.createWritable() });
                if (ok) {
                    documentFileHandle = handle;
                    events.fire('doc.setName', handle.name);
                    events.fire('doc.saved');
                    recentFiles.add(handle);
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        } else {
            const ok = await saveDocument({
                filename: 'scene.ssproj'
            });
            if (ok) events.fire('doc.saved');
        }
    });

    // doc name

    let docName: string = null;

    const setDocName = (name: string) => {
        if (name !== docName) {
            docName = name;
            events.fire('doc.name', docName);
        }
    };

    events.function('doc.name', () => {
        return docName;
    });

    events.on('doc.setName', (name) => {
        setDocName(name);
    });
};

export { registerDocEvents };
