import { Mat4, path, Quat, Vec3 } from 'playcanvas';

import { deserializeGrade, serializeGrade, sidecarFilename } from './color-grade-file';
import { CreateDropHandler } from './drop-handler';
import { Events } from '../core/events';
import { renderDiagnostics } from '../core/render-diagnostics';
import { BrowserFileSystem, MappedReadFileSystem } from '../io/index';
import { attachLodFromFile } from '../lod/lod-file';
import { CropBox } from '../scene/crop-box';
import { ElementType } from '../scene/element';
import { Scene } from '../scene/scene';
import { Splat } from '../splat/splat';
import { SerializeSettings, serializeSog, serializeSpz, serializeViewer, SogSettings, SpzSettings, ViewerExportSettings, WebGPUUnavailableError, writeSplatFile } from '../splat/splat-serialize';
import { State } from '../splat/splat-state';
import { i18n } from '../ui/localization';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

type ExportType = 'ply' | 'splat' | 'sog' | 'spz' | 'viewer';

type FileType = 'ply' | 'compressedPly' | 'splat' | 'sog' | 'spz' | 'htmlViewer' | 'packageViewer';

interface SceneExportOptions {
    filename: string;
    splatIdx: 'all' | number;
    serializeSettings: SerializeSettings;

    // ply
    compressedPly?: boolean;

    // sog
    sogIterations?: number;

    // spz
    spzVersion?: 3 | 4;

    // viewer
    viewerExportSettings?: ViewerExportSettings;
}

const filePickerTypes: { [key: string]: FilePickerAcceptType } = {
    'ply': {
        description: 'Gaussian Splat PLY File',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'compressedPly': {
        description: 'Compressed Gaussian Splat PLY File',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'sog': {
        description: 'SOG Scene',
        accept: {
            'application/x-gaussian-splat': ['.json', '.sog'],
            'image/webp': ['.webp']
        }
    },
    'lcc': {
        description: 'LCC Scene',
        accept: {
            'application/x-lcc': ['.lcc', '.lcc2', '.bin']
        }
    },
    'splat': {
        description: 'Splat File',
        accept: {
            'application/x-gaussian-splat': ['.splat']
        }
    },
    'ksplat': {
        description: 'KSplat File',
        accept: {
            'application/x-gaussian-splat': ['.ksplat']
        }
    },
    'spz': {
        description: 'SPZ File (Niantic)',
        accept: {
            'application/x-gaussian-splat': ['.spz']
        }
    },
    'indexTxt': {
        description: 'Colmap Poses (Images.txt)',
        accept: {
            'text/plain': ['.txt']
        }
    },
    'htmlViewer': {
        description: 'Viewer HTML',
        accept: {
            'text/html': ['.html']
        }
    },
    'packageViewer': {
        description: 'Viewer ZIP',
        accept: {
            'application/zip': ['.zip']
        }
    }
};

const allImportTypes = {
    description: 'Supported Files',
    accept: {
        'application/ply': ['.ply'],
        'application/x-gaussian-splat': ['.json', '.sog', '.splat', '.ksplat', '.spz'],
        'image/webp': ['.webp'],
        'application/x-lcc': ['.lcc', '.lcc2', '.bin'],
        'text/plain': ['.txt']
    }
};

// determine if all files share a common filename prefix followed by
// a frame number, e.g. "frame0001.ply", "frame0002.ply", etc.
const isPlySequence = (filenames: string[]) => {
    if (filenames.length < 2) {
        return false;
    }

    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const regex = /(.*?)(\d+)(?:\.compressed)?\.ply$/;
    const baseMatch = filenames[0].match(regex);
    if (!baseMatch) {
        return false;
    }

    for (let i = 1; i < filenames.length; i++) {
        const thisMatch = filenames[i].match(regex);
        if (!thisMatch || thisMatch[1] !== baseMatch[1]) {
            return false;
        }
    }

    return true;
};

// SOG has a meta.json file; streamed SOG has a lod-meta.json file.
const isSog = (filenames: string[]) => {
    const count = (extension: string) => filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
    return count('lod-meta.json') === 1 || count('meta.json') === 1;
};

// The LCC file contains meta.lcc, index.bin, data.bin and shcoef.bin (optional).
// LCC2 comprises a meta.lcc2 file and .sog/.spz chunk files.
const isLcc = (filenames: string[]) => {
    const count = (extension: string) => filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
    return count('.lcc') === 1 || count('.lcc2') === 1;
};

type ImportFile = {
    filename: string;
    url?: string;
    contents?: File;
    handle?: FileSystemFileHandle;
};

const vec = new Vec3();

// load inria camera poses from json file
const loadCameraPoses = async (file: ImportFile, events: Events) => {
    const response = new Response(file.contents);
    const json = await response.json();

    if (json.length > 0) {
        // sort entries by trailing number if it exists
        const sorter = (a: any, b: any) => {
            const avalue = a.id ?? a.img_name?.match(/\d*$/)?.[0];
            const bvalue = b.id ?? b.img_name?.match(/\d*$/)?.[0];
            return (avalue && bvalue) ? parseInt(avalue, 10) - parseInt(bvalue, 10) : 0;
        };

        json.sort(sorter).forEach((pose: any, i: number) => {
            if (pose.hasOwnProperty('position') && pose.hasOwnProperty('rotation')) {
                const p = new Vec3(pose.position);
                const z = new Vec3(pose.rotation[0][2], pose.rotation[1][2], pose.rotation[2][2]);

                // Use fixed offset along Z-axis direction instead of variable dot product
                vec.copy(z).mulScalar(10).add(p);

                // compute max FOV from intrinsics (vertical or horizontal, whichever is larger)
                let fov = 60;
                if (pose.fx && pose.fy && pose.width && pose.height) {
                    const fovX = 2 * Math.atan(pose.width / (2 * pose.fx)) * (180 / Math.PI);
                    const fovY = 2 * Math.atan(pose.height / (2 * pose.fy)) * (180 / Math.PI);
                    fov = Math.max(fovX, fovY);
                }

                events.fire('camera.addPose', {
                    name: pose.img_name ?? `${file.filename}_${i}`,
                    frame: i,
                    position: new Vec3(-p.x, -p.y, p.z),
                    target: new Vec3(-vec.x, -vec.y, vec.z),
                    fov
                });
            }
        });
    }
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

// https://colmap.github.io/format.html#images-txt
const loadImagesTxt = async (file: ImportFile, events: Events) => {
    const response = new Response(file.contents);
    const text = await response.text();

    // split into lines, remove comments and empty lines
    const poses = text.split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('#'))      // remove comments
    .filter((_, i) => i % 2 === 0)              // remove every second line
    .map((line, i) => {
        const parts = line.split(' ');
        if (parts.length !== 10) {
            return null;
        }
        const name = parts[9];
        const order = parseInt(removeExtension(name).match(/\d+$/)?.[0], 10);
        return {
            w: parseFloat(parts[1]),
            x: parseFloat(parts[2]),
            y: parseFloat(parts[3]),
            z: parseFloat(parts[4]),
            tx: parseFloat(parts[5]),
            ty: parseFloat(parts[6]),
            tz: parseFloat(parts[7]),
            name: name ?? `${file.filename}_${i}`,
            order: isFinite(order) ? order : i
        };
    })
    .filter(entry => !!entry)
    .sort((a, b) => (a.order < b.order ? -1 : 1));

    const q = new Quat();
    const t = new Vec3();

    poses.forEach((pose, i) => {
        const { w, x, y, z, tx, ty, tz } = pose;

        q.set(x, y, z, w).normalize().invert();
        t.set(-tx, -ty, -tz);
        q.transformVector(t, t);

        q.transformVector(Vec3.BACK, vec);
        vec.mulScalar(10).add(t);

        events.fire('camera.addPose', {
            name: pose.name,
            frame: i,
            position: new Vec3(-t.x, -t.y, t.z),
            target: new Vec3(-vec.x, -vec.y, vec.z)
        });
    });
};

// initialize file handler events
const initFileHandler = (scene: Scene, events: Events, dropTarget: HTMLElement) => {

    const showLoadError = async (message: string, filename: string) => {
        await events.invoke('showPopup', {
            type: 'error',
            header: i18n.t('popup.error-loading'),
            message: `${message} while loading '${filename}'`
        });
    };

    // Give the engine a moment to finish setting the instance up (the sorter and
    // the first sort land a frame or two after the element is added), then say
    // what is missing if the splat still cannot be drawn. Silence here is what
    // made "the model opens but nothing shows" hard to diagnose.
    const reportIfNotRenderable = async (model: Splat, filename: string) => {
        await new Promise<void>((resolve) => {
            window.setTimeout(() => resolve(), 4000);
        });
        // the user may have closed or replaced the model in the meantime
        if (!model.scene || !model.entity?.parent) {
            return;
        }
        const diag = renderDiagnostics(model);
        if (diag.ok) {
            return;
        }
        console.warn(`[SplatRoom] '${filename}' ${diag.summary}`, diag.facts);
        await events.invoke('showPopup', {
            type: 'error',
            header: i18n.t('popup.error-loading'),
            message: [
                `'${filename}' loaded but cannot be displayed.`,
                '',
                diag.summary,
                ...(diag.warnings.length ? ['', ...diag.warnings] : []),
                '',
                `Diagnostics: ${JSON.stringify(diag.facts)}`,
                'Run splatDiag() in the developer console for the same report.'
            ].join('\n')
        });
    };

    // console helper: splatDiag() reports why each loaded model is (or is not)
    // renderable — the quickest thing to paste back when a model loads blank
    (window as any).splatDiag = () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[]).map(renderDiagnostics);
    };

    // import splat model(s) - handles single files, SOG, and LCC formats
    const importSplatModel = async (files: ImportFile[], animationFrame: boolean) => {
        try {
            const filenames = files.map(f => f.filename.toLowerCase());

            // Determine the main file based on format
            let mainIndex: number;
            if (filenames.some(f => f === 'meta.json' || f === 'lod-meta.json')) {
                mainIndex = filenames.findIndex(f => f === 'meta.json' || f === 'lod-meta.json');
            } else if (filenames.some(f => f.endsWith('.lcc') || f.endsWith('.lcc2'))) {
                mainIndex = filenames.findIndex(f => f.endsWith('.lcc') || f.endsWith('.lcc2'));
            } else {
                mainIndex = 0;  // Single file case
            }

            const mainFile = files[mainIndex];
            const baseUrl = mainFile.url ? new URL('.', new URL(mainFile.url, window.location.href)).href : undefined;

            // Create file system with all local files, falling back to URL loading
            const fileSystem = new MappedReadFileSystem(baseUrl);
            files.forEach((f) => {
                if (f.contents) fileSystem.addFile(f.filename, f.contents);
            });

            // Multi-file container formats must load by their relative name so the
            // library resolves sibling files against the file system's baseUrl
            // (path-joining a full URL corrupts the 'http://' prefix)
            const lowerMainFilename = mainFile.filename.toLowerCase();
            const isContainer = lowerMainFilename === 'meta.json' || lowerMainFilename === 'lod-meta.json' || lowerMainFilename.endsWith('.lcc') || lowerMainFilename.endsWith('.lcc2');

            // For URL-only single file, use full URL as filename
            const filename = (files.length === 1 && !mainFile.contents && mainFile.url && !isContainer) ?
                mainFile.url :
                mainFile.filename;

            // sanitize (giant-grey-splat popup) only for user-initiated imports,
            // never for internal round-trips or animation frames
            const model = await scene.assetLoader.load(filename, fileSystem, animationFrame, undefined, !animationFrame);
            if (!model) {
                // user cancelled the load
                return null;
            }
            await scene.add(model);
            // V3 streaming: structural multi-LOD containers (.lod / .lcc2 /
            // streamed .sog) carry their coarse levels in-file — attach them as
            // runtime LOD proxies so the camera switcher uses lighter data at
            // distance (no re-decimation). Best-effort.
            if (isContainer) {
                void attachLodFromFile(fileSystem, mainFile.filename, model);
            }
            // a model that loads but cannot be drawn would otherwise leave an
            // empty viewport with no explanation: check shortly after the load
            // and report what is missing
            if (!animationFrame) {
                void reportIfNotRenderable(model, filename);
            }
            return model;
        } catch (error) {
            const displayName = files[0]?.filename ?? 'unknown';
            const stack = (error as any)?.stack?.split('\n').slice(1, 4).join('\n') ?? '';
            await showLoadError(`${(error as any)?.message ?? error}\n\n${stack}`.trim(), displayName);
        }
    };

    // figure out what the set of files are (ply sequence, document, sog set, ply) and then import them
    const importFiles = async (files: ImportFile[], animationFrame = false) => {
        const filenames = files.map(f => f.filename.toLowerCase());

        const result: Splat[] = [];

        if (isPlySequence(filenames)) {
            // handle ply sequence
            events.fire('sequence.setPlyFrames', files.map(f => f.contents));
            events.fire('timeline.frame', 0);
        } else if (isSog(filenames) || isLcc(filenames)) {
            const model = await importSplatModel(files, animationFrame);
            if (model) result.push(model);
        } else {
            // check for unrecognized file types
            for (let i = 0; i < filenames.length; i++) {
                const filename = filenames[i].toLowerCase();
                if (['.ssproj', '.ply', '.splat', '.sog', '.webp', 'images.txt', '.json', '.ksplat', '.spz'].every(ext => !filename.endsWith(ext))) {
                    await showLoadError('Unrecognized file type', filename);
                    return;
                }
            }

            // handle multiple files as independent imports
            for (let i = 0; i < files.length; i++) {
                const filename = filenames[i].toLowerCase();

                if (filename.endsWith('.ssproj')) {
                    // load ssproj document
                    await events.invoke('doc.load', files[i].contents ?? (await fetch(files[i].url)).arrayBuffer(), files[i].handle);
                } else if (['.ply', '.splat', '.sog', '.ksplat', '.spz'].some(ext => filename.endsWith(ext))) {
                    // load gaussian splat model
                    const model = await importSplatModel([files[i]], animationFrame);
                    if (model) {
                        result.push(model);

                        // auto-detect sidecar color grade file
                        const sscgName = sidecarFilename(files[i].filename);
                        const sscgFile = files.find(f => f.filename === sscgName || f.filename.toLowerCase() === sscgName.toLowerCase());
                        if (sscgFile && sscgFile.contents) {
                            try {
                                const text = await new Response(sscgFile.contents).text();
                                const gradeData = JSON.parse(text);
                                deserializeGrade(model, gradeData);
                            } catch (e) {
                                console.warn(`Failed to load color grade sidecar: ${sscgName}`, e);
                            }
                        } else if (files[i].url) {
                            // try to fetch sidecar from URL
                            try {
                                const sscgUrl = files[i].url.endsWith('/') ?
                                    `${files[i].url}${sscgName}` :
                                    `${files[i].url.substring(0, files[i].url.lastIndexOf('/') + 1)}${sscgName}`;
                                const response = await fetch(sscgUrl);
                                if (response.ok) {
                                    const gradeData = await response.json();
                                    deserializeGrade(model, gradeData);
                                }
                            } catch (_e) {
                                // sidecar not available at URL, that's fine
                            }
                        }
                    }
                } else if (filename.endsWith('images.txt')) {
                    // load colmap frames
                    await loadImagesTxt(files[i], events);
                } else if (filename.endsWith('.json')) {
                    // load inria camera poses
                    await loadCameraPoses(files[i], events);
                }
            }
        }

        return result;
    };

    events.function('import', (files: ImportFile[], animationFrame = false) => {
        return importFiles(files, animationFrame);
    });

    // create a file selector element as fallback when showOpenFilePicker isn't available
    let fileSelector: HTMLInputElement;
    if (!window.showOpenFilePicker) {
        fileSelector = document.createElement('input');
        fileSelector.setAttribute('id', 'file-selector');
        fileSelector.setAttribute('type', 'file');
        fileSelector.setAttribute('accept', '.ply,.splat,meta.json,.json,.webp,.ssproj,.sog,.lcc,.lcc2,.bin,.txt,.ksplat,.spz');
        fileSelector.setAttribute('multiple', 'true');

        fileSelector.onchange = () => {
            const files = [];
            for (let i = 0; i < fileSelector.files.length; i++) {
                const file = fileSelector.files[i];
                files.push({
                    filename: file.name,
                    contents: file
                });
            }
            importFiles(files);
            fileSelector.value = '';
        };
        document.body.append(fileSelector);
    }

    // create the file drag & drop handler
    CreateDropHandler(dropTarget, (entries, shift) => {
        importFiles(entries.map((e) => {
            return {
                filename: e.filename,
                contents: e.file,
                handle: e.handle
            };
        }));
    });

    // get the list of visible splats containing gaussians
    const getSplats = () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible)
        .filter(splat => splat.numSplats > 0);
    };

    events.function('scene.allSplats', () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[]);
    });
    events.function('scene.splats', () => {
        return getSplats();
    });

    // Mark gaussians outside the active crop shape as deleted in the splat
    // STATE array (the serializers skip deleted splats), so every export
    // format (ply / compressed-ply / splat / sog / spz / viewer) saves the
    // CROPPED result. Returns a restore function that undoes the marking.
    const applyCropToExport = (splats: Splat[], ev: Events): (() => void) => {
        const cropBox = ev.invoke('cropBox') as CropBox | null;
        const noop = () => { /* nothing to restore */ };
        if (!cropBox || !cropBox.enabled) return noop;

        const worldMat = new Mat4();
        const srcVec = new Vec3();
        const worldVec = new Vec3();
        const restoreFns: (() => void)[] = [];

        for (const splat of splats) {
            const data = splat.splatData;
            if (!data) continue;
            const state = data.getProp('state') as Uint8Array | null;
            const xs = data.getProp('x') as Float32Array | null;
            const ys = data.getProp('y') as Float32Array | null;
            const zs = data.getProp('z') as Float32Array | null;
            if (!state || !xs || !ys || !zs) continue;

            worldMat.copy(splat.worldTransform);
            const n = data.numSplats;
            // snapshot BEFORE marking — restoring needs the pre-export bytes
            const orig = state.slice();
            const changed: number[] = [];

            for (let i = 0; i < n; i++) {
                // already deleted → skip (no need to re-mark)
                if ((state[i] & State.deleted) !== 0) continue;
                srcVec.set(xs[i], ys[i], zs[i]);
                worldMat.transformPoint(srcVec, worldVec);
                if (!cropBox.isPointInsideWorld(worldVec.x, worldVec.y, worldVec.z)) {
                    state[i] |= State.deleted;
                    changed.push(i);
                }
            }

            if (changed.length > 0) {
                restoreFns.push(() => {
                    for (const idx of changed) state[idx] = orig[idx];
                });
            }
        }

        if (restoreFns.length === 0) return noop;
        return () => {
            for (const fn of restoreFns) fn();
            // the state array drives UI (deleted splats render red) — force a
            // refresh so the viewport returns to normal after the export
            scene.forceRender = true;
        };
    };

    events.function('scene.empty', () => {
        return getSplats().length === 0;
    });

    events.function('scene.import', async () => {
        if (fileSelector) {
            fileSelector.click();
        } else {
            try {
                const handles = await window.showOpenFilePicker({
                    id: 'SplatRoomFileImport',
                    multiple: true,
                    excludeAcceptAllOption: false,
                    types: [
                        allImportTypes,
                        filePickerTypes.ply,
                        filePickerTypes.compressedPly,
                        filePickerTypes.splat,
                        filePickerTypes.sog,
                        filePickerTypes.lcc,
                        filePickerTypes.ksplat,
                        filePickerTypes.spz,
                        filePickerTypes.indexTxt
                    ]
                });

                const files = [];
                for (let i = 0; i < handles.length; i++) {
                    files.push({
                        filename: handles[i].name,
                        contents: await handles[i].getFile()
                    });
                }

                importFiles(files);

            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        }
    });

    // open a folder
    events.function('scene.openAnimation', async () => {
        try {
            const handle = await window.showDirectoryPicker({
                id: 'SplatRoomFileOpenAnimation',
                mode: 'readwrite'
            });

            if (handle) {
                const files = [];
                for await (const value of handle.values()) {
                    if (value.kind === 'file') {
                        const file = await value.getFile();
                        if (file.name.toLowerCase().endsWith('.ply')) {
                            files.push(file);
                        }
                    }
                }
                events.fire('sequence.setPlyFrames', files);
                events.fire('timeline.frame', 0);
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(error);
            }
        }
    });

    events.function('scene.export', async (exportType: ExportType) => {
        const splats = getSplats();

        const hasFilePicker = !!window.showSaveFilePicker;
        // show viewer export options
        const options = await events.invoke('show.exportPopup', exportType, splats.map(s => s.name), !hasFilePicker) as SceneExportOptions;

        // return if user cancelled
        if (!options) {
            return;
        }

        const fileType: FileType =
            (exportType === 'viewer') ? (options.viewerExportSettings!.type === 'zip' ? 'packageViewer' : 'htmlViewer') :
                (exportType === 'ply') ? (options.compressedPly ? 'compressedPly' : 'ply') :
                    (exportType === 'sog') ? 'sog' :
                        (exportType === 'spz') ? 'spz' : 'splat';

        if (hasFilePicker) {
            try {
                const fileHandle = await window.showSaveFilePicker({
                    id: 'SplatRoomFileExport',
                    types: [filePickerTypes[fileType]],
                    suggestedName: options.filename
                });
                await events.invoke('scene.write', fileType, options, await fileHandle.createWritable());
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        } else {
            await events.invoke('scene.write', fileType, options);
        }
    });

    events.function('scene.write', async (fileType: FileType, options: SceneExportOptions, stream?: FileSystemWritableFileStream) => {
        // SOG, SPZ and viewer exports have their own progress UI, other formats use spinner
        const useSpinner = fileType !== 'sog' && fileType !== 'spz' && fileType !== 'htmlViewer' && fileType !== 'packageViewer';

        if (useSpinner) {
            events.fire('startSpinner');
        }

        // 预估输出体积（GB）：在 try 之外声明，这样 catch 里的"内存不够"提示也能用上
        let estimatedOutputGB = '?';

        try {
            // setTimeout so spinner/progress has a chance to activate
            await new Promise<void>((resolve) => {
                setTimeout(resolve);
            });

            const { filename, splatIdx, serializeSettings, viewerExportSettings } = options;

            // Create FileSystem for output
            const fs = new BrowserFileSystem(filename, stream);

            const splats = splatIdx === 'all' ? getSplats() : [getSplats()[splatIdx]];

            // 预估输出体积（GB，一位小数）。只用于出错时给一句能照做的提示，不做任何拦截：
            // 每行字节数按导出格式的列数取经验值（PLY 带 3 阶 SH 是 59 列 × 4B ≈ 236B）。
            const totalRows = splats.reduce((n, s) => n + s.splatData.numSplats, 0);
            const bytesPerRow = ({
                ply: 236,
                compressedPly: 60,
                splat: 32,
                spz: 16,
                sog: 8
            } as Record<string, number>)[fileType] ?? 236;
            estimatedOutputGB = Math.max(0.1, (totalRows * bytesPerRow) / 1073741824).toFixed(1);

            // Apply the crop box to the exported data: gaussians outside the
            // crop shape are temporarily flagged as deleted (the serializers
            // skip deleted splats), so the saved file matches the cropped view.
            // The original state bytes are restored afterwards.
            const restore = applyCropToExport(splats, events);
            try {
                switch (fileType) {
                    case 'ply':
                        // sanitize like the other formats: drop invalid
                        // (NaN/±Inf) gaussians and fully-transparent ones —
                        // the .ply/.splat writers write position/scale raw, so
                        // NaN would land on disk unguarded
                        serializeSettings.minOpacity = 1 / 255;
                        serializeSettings.removeInvalid = true;
                        await writeSplatFile(splats, serializeSettings, 'ply', 'output.ply', {}, fs);
                        break;
                    case 'compressedPly':
                        serializeSettings.minOpacity = 1 / 255;
                        serializeSettings.removeInvalid = true;
                        await writeSplatFile(splats, serializeSettings, 'compressed-ply', 'output.compressed.ply', {}, fs);
                        break;
                    case 'splat':
                        serializeSettings.minOpacity = 1 / 255;
                        serializeSettings.removeInvalid = true;
                        await writeSplatFile(splats, serializeSettings, 'splat', 'output.splat', {}, fs);
                        break;
                    case 'sog': {
                        const sogSettings: SogSettings = {
                            ...serializeSettings,
                            minOpacity: 1 / 255,
                            removeInvalid: true,
                            iterations: options.sogIterations ?? 10,
                            events
                        };
                        // Single-file SOG (bundle zip) supports up to the WebP
                        // texel ceiling (~268M gaussians) and is what the loader
                        // reads back (meta.json inside the zip). The streaming
                        // LOD writer emits a lod-meta.json tree that the loader
                        // does NOT understand, and it also writes multiple files
                        // into a single FileSystemWritableFileStream (which
                        // closes after the first file → "Cannot write to a
                        // CLOSED writable stream"). Route everything through the
                        // single-file path; 14.7M-gaussian scenes are well within
                        // its limits.
                        await serializeSog(splats, sogSettings, fs);
                        break;
                    }
                    case 'spz': {
                        const spzSettings: SpzSettings = {
                            ...serializeSettings,
                            minOpacity: 1 / 255,
                            removeInvalid: true,
                            version: options.spzVersion ?? 4,
                            events
                        };
                        await serializeSpz(splats, spzSettings, fs);
                        break;
                    }
                    case 'htmlViewer':
                    case 'packageViewer':
                        await serializeViewer(splats, serializeSettings, { ...viewerExportSettings!, events }, fs);
                        break;
                }
            } finally {
                restore();
            }

        } catch (error) {
            if (error instanceof WebGPUUnavailableError) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: i18n.t('popup.webgpu-unavailable')
                });
            } else {
                const message = error instanceof Error ? error.message : String(error);
                // 分配失败时给一句能照做的话，而不是把 Chromium 的
                // "Array buffer allocation failed while saving file" 直接甩给用户。
                // 实测（93 万点 / 48 列 SH）：导出 231MB 时序列化器会出现**一次 209.7MB 的单次分配**
                // （MemoryFileSystem 的 close 把整份文件拼成一块），所以体积大的导出确实可能顶到上限。
                const isAllocation = /array buffer allocation failed|allocation failed|out of memory|oom/i.test(message);
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: isAllocation ?
                        i18n.t('popup.exportOutOfMemory', { size: estimatedOutputGB }) :
                        `${message} while saving file`
                });
            }
        } finally {
            if (useSpinner) {
                events.fire('stopSpinner');
            }
        }
    });
};

export { initFileHandler, ExportType, SceneExportOptions };
