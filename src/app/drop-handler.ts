import { path } from 'playcanvas';

class DroppedFile {
    filename: string;
    file: File;
    handle?: FileSystemFileHandle;

    constructor(filename: string, file: File, handle?: FileSystemFileHandle) {
        this.filename = filename;
        this.file = file;
        this.handle = handle;
    }
}

type DropHandlerFunc = (files: Array<DroppedFile>, resetScene: boolean) => void;

const resolveDirectories = (entries: Array<FileSystemEntry>): Promise<Array<FileSystemFileEntry>> => {
    const promises: Promise<Array<FileSystemFileEntry>>[] = [];
    const result: Array<FileSystemFileEntry> = [];

    entries.forEach((entry) => {
        if (entry.name === '.DS_Store') {
            return;
        }

        if (entry.isFile) {
            result.push(entry as FileSystemFileEntry);
        } else if (entry.isDirectory) {
            promises.push(
                new Promise<any>((resolve, reject) => {
                    const reader = (entry as FileSystemDirectoryEntry).createReader();

                    const p: Promise<any>[] = [];

                    const read = () => {
                        reader.readEntries((children: Array<FileSystemEntry>) => {
                            if (children.length > 0) {
                                p.push(resolveDirectories(children));
                                read();
                            } else {
                                Promise.all(p).then((children: Array<Array<FileSystemFileEntry>>) => {
                                    resolve(children.flat());
                                });
                            }
                        });
                    };
                    read();
                })
            );
        }
    });

    return Promise.all(promises).then((children: Array<Array<FileSystemFileEntry>>) => {
        return result.concat(...children);
    });
};

const removeCommonPrefix = (urls: Array<DroppedFile>) => {
    const split = (pathname: string) => {
        const parts = pathname.split(path.delimiter);
        const base = parts[0];
        const rest = parts.slice(1).join(path.delimiter);
        return [base, rest];
    };
    while (true) {
        const parts = split(urls[0].filename);
        if (parts[1].length === 0) {
            return;
        }
        for (let i = 1; i < urls.length; ++i) {
            const other = split(urls[i].filename);
            if (parts[0] !== other[0]) {
                return;
            }
        }
        for (let i = 0; i < urls.length; ++i) {
            urls[i].filename = split(urls[i].filename)[1];
        }
    }
};

// configure drag and drop
const CreateDropHandler = (target: HTMLElement, dropHandler: DropHandlerFunc) => {

    const dragstart = (ev: DragEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.effectAllowed = 'all';
    };

    const dragover = (ev: DragEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.effectAllowed = 'all';
    };

    const drop = async (ev: DragEvent) => {
        ev.preventDefault();

        const items = Array.from(ev.dataTransfer.items);

        // handle single file drops so documents can propagate the filesystemfilehandle
        if (items.length === 1) {
            const item = items[0];
            // defensive: webkitGetAsEntry may be absent or return null for
            // non-file payloads (URL drops etc.) — never throw here, or the
            // drop is silently swallowed and the browser's default action
            // (open/download) may take over.
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (item.getAsFileSystemHandle && entry && entry.isFile) {
                const handle = await item.getAsFileSystemHandle();
                if (handle?.kind === 'file') {
                    const fileHandle = handle as FileSystemFileHandle;
                    const file = await fileHandle.getFile();
                    const droppedFile = new DroppedFile(file.name, file, fileHandle);
                    dropHandler([droppedFile], ev.shiftKey);
                    return;
                }
            }
        }

        // Map to entries first
        const entries = items
        .map(item => item.webkitGetAsEntry())
        .filter(v => v);

        // resolve directories to files
        const resolvedEntries = await resolveDirectories(entries);

        const files = await Promise.all(
            resolvedEntries.map((entry) => {
                return new Promise<DroppedFile>((resolve, reject) => {
                    entry.file((entryFile: any) => {
                        resolve(new DroppedFile(entry.fullPath.substring(1), entryFile));
                    });
                });
            })
        );

        if (files.length > 1) {
            // if all files share a common filename prefix, remove it
            removeCommonPrefix(files);
        }

        // finally, call the drop handler
        dropHandler(files, ev.shiftKey);
    };

    // Listen on the WHOLE document (not just `target`), so a drop anywhere —
    // including page edges, toolbars and the preview panel chrome — is
    // intercepted. Otherwise the browser's default action for a file drop
    // (open / download the file) takes over and the model never loads.
    const root = document;
    root.addEventListener('dragstart', dragstart, true);
    root.addEventListener('dragover', dragover, true);
    root.addEventListener('drop', drop, true);
};

export { CreateDropHandler };
