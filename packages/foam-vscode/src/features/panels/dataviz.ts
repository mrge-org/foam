import * as vscode from 'vscode';
import { Foam } from '../../core/model/foam';
import { Logger } from '../../core/utils/log';
import { fromVsCodeUri, toVsCodeUri } from '../../utils/vsc-utils';
import { isSome } from '../../core/utils';

export default async function activate(
  context: vscode.ExtensionContext,
  foamPromise: Promise<Foam>
) {
  let panel: vscode.WebviewPanel | undefined = undefined;
  vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('foam.graph.style')) {
      const style = getGraphStyle();
      panel?.webview?.postMessage({
        type: 'didUpdateStyle',
        payload: style,
      });
    }
    if (event.affectsConfiguration('foam.graph.showFolders')) {
      const showFolders = getShowFolders();
      panel?.webview?.postMessage({
        type: 'didUpdateShowFolders',
        payload: showFolders,
      });
    }
    if (event.affectsConfiguration('foam.graph.excludedFolders')) {
      const excluded = getExcludedFolders();
      panel?.webview?.postMessage({
        type: 'didUpdateExcludedFolders',
        payload: excluded,
      });
    }
  });

  vscode.commands.registerCommand('foam-vscode.show-graph', async () => {
    if (panel) {
      const columnToShowIn = vscode.window.activeTextEditor
        ? vscode.window.activeTextEditor.viewColumn
        : undefined;
      panel.reveal(columnToShowIn);
    } else {
      const foam = await foamPromise;
      panel = await createGraphPanel(foam, context);
      const onFoamChanged = _ => {
        updateGraph(panel, foam);
      };

      const noteUpdatedListener = foam.graph.onDidUpdate(onFoamChanged);
      panel.onDidDispose(() => {
        noteUpdatedListener.dispose();
        panel = undefined;
      });

      vscode.window.onDidChangeActiveTextEditor(e => {
        if (e?.document?.uri?.scheme !== 'untitled') {
          const note = foam.workspace.get(fromVsCodeUri(e.document.uri));
          if (isSome(note)) {
            panel.webview.postMessage({
              type: 'didSelectNote',
              payload: note.uri.path,
            });
          }
        }
      });
    }
  });
}

function updateGraph(panel: vscode.WebviewPanel, foam: Foam) {
  const graph = generateGraphData(foam);
  panel.webview.postMessage({
    type: 'didUpdateGraphData',
    payload: graph,
  });
}

function generateGraphData(foam: Foam) {
  const graph = {
    nodeInfo: {},
    edges: new Set(),
  };
  // keep a simple key set to avoid adding duplicate edges
  const edgeKeys = new Set<string>();
  const addEdge = (source: string, target: string) => {
    const key = `${source}->${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    graph.edges.add({ source, target });
  };

  foam.workspace.list().forEach(n => {
    const type = n.type === 'note' ? n.properties.type ?? 'note' : n.type;
    const title = n.type === 'note' ? n.title : n.uri.getBasename();
    // derive folder information (best-effort)
    let parentFolderName: string | undefined = undefined;
    let parentFolderId: string | undefined = undefined;
    try {
      const folderUri = n.uri.getDirectory();
      parentFolderName = getFolderNameForDisplay(folderUri);
      parentFolderId = folderUri.path;
    } catch {}

    graph.nodeInfo[n.uri.path] = {
      id: n.uri.path,
      type: type,
      uri: n.uri,
      title: cutTitle(title),
      properties: n.properties,
      tags: n.tags,
      parentFolderName: parentFolderName,
      parentFolderId: parentFolderId,
    };

    // Add folder node and edge (note -> folder)
    try {
      const folderUri = n.uri.getDirectory();
      const folderId = folderUri.path;
      if (folderId && folderId !== n.uri.path) {
        if (!graph.nodeInfo[folderId]) {
          const folderTitle = getFolderNameForDisplay(folderUri);
          graph.nodeInfo[folderId] = {
            id: folderId,
            type: 'folder',
            uri: folderUri,
            title: cutTitle(folderTitle),
            properties: {},
            folderName: folderTitle,
            parentFolderId: undefined as any, // will be set below if parent exists
          } as any;
        }
        addEdge(n.uri.path, folderId);

        // Build full folder ancestry: link folder -> parent -> ... -> root
        try {
          let child = folderUri;
          while (true) {
            const parent = child.getDirectory();
            const childId = child.path;
            const parentId = parent.path;
            if (!parentId || parentId === childId) break; // reached root

            if (!graph.nodeInfo[parentId]) {
              const parentTitle = getFolderNameForDisplay(parent);
              graph.nodeInfo[parentId] = {
                id: parentId,
                type: 'folder',
                uri: parent,
                title: cutTitle(parentTitle),
                properties: {},
                folderName: parentTitle,
                parentFolderId: undefined as any,
              } as any;
            }
            addEdge(childId, parentId);
            // set parent pointer on child folder node
            (graph.nodeInfo[childId] as any).parentFolderId = parentId;
            child = parent;
          }
        } catch {}
      }
    } catch (err) {
      // be resilient: folder derivation should not break graph rendering
    }
  });
  foam.graph.getAllConnections().forEach(c => {
    addEdge(c.source.path, c.target.path);
    if (c.target.isPlaceholder()) {
      graph.nodeInfo[c.target.path] = {
        id: c.target.path,
        type: 'placeholder',
        uri: c.target,
        title: c.target.path,
        properties: {},
      };
    }
  });

  return {
    nodeInfo: graph.nodeInfo,
    links: Array.from(graph.edges),
  };
}

function cutTitle(title: string): string {
  const maxLen = vscode.workspace
    .getConfiguration('foam.graph')
    .get('titleMaxLength', 24);
  if (maxLen > 0 && title.length > maxLen) {
    return title.substring(0, maxLen).concat('...');
  }
  return title;
}

async function createGraphPanel(foam: Foam, context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'foam-graph',
    'Foam Graph',
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.webview.html = await getWebviewContent(context, panel);

  panel.webview.onDidReceiveMessage(
    async message => {
      switch (message.type) {
        case 'webviewDidLoad': {
          const styles = getGraphStyle();
          panel.webview.postMessage({
            type: 'didUpdateStyle',
            payload: styles,
          });
          panel.webview.postMessage({
            type: 'didUpdateShowFolders',
            payload: getShowFolders(),
          });
          panel.webview.postMessage({
            type: 'didUpdateExcludedFolders',
            payload: getExcludedFolders(),
          });
          updateGraph(panel, foam);
          break;
        }
        case 'webviewDidSelectNode': {
          const payload = message.payload;
          const id: string = typeof payload === 'string' ? payload : payload?.id;
          const type: string | undefined =
            typeof payload === 'object' ? payload?.type : undefined;

          if (!id) {
            break;
          }

          const uri = vscode.Uri.parse(id);
          if (type === 'folder') {
            // Try to reveal folder in explorer, fallback to opening first file
            try {
              await vscode.commands.executeCommand('revealInExplorer', uri);
            } catch {}
            try {
              const entries = await vscode.workspace.fs.readDirectory(uri);
              const firstFile = entries.find(([name, fileType]) => fileType === vscode.FileType.File);
              if (firstFile) {
                const child = vscode.Uri.joinPath(uri, firstFile[0]);
                await vscode.commands.executeCommand('vscode.open', child, vscode.ViewColumn.One);
              }
            } catch {}
          } else {
            const selectedNote = foam.workspace.get(fromVsCodeUri(uri));
            if (isSome(selectedNote)) {
              vscode.commands.executeCommand('vscode.open', uri, vscode.ViewColumn.One);
            }
          }
          break;
        }
        case 'error': {
          Logger.error('An error occurred in the graph view', message.payload);
          break;
        }
      }
    },
    undefined,
    context.subscriptions
  );

  return panel;
}

async function getWebviewContent(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel
) {
  const datavizUri = vscode.Uri.joinPath(
    context.extensionUri,
    'static',
    'dataviz'
  );
  const getWebviewUri = (fileName: string) =>
    panel.webview.asWebviewUri(vscode.Uri.joinPath(datavizUri, fileName));

  const indexHtml =
    vscode.env.uiKind === vscode.UIKind.Desktop
      ? new TextDecoder('utf-8').decode(
          await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(datavizUri, 'index.html')
          )
        )
      : await fetch(getWebviewUri('index.html').toString()).then(r => r.text());

  // Replace the script paths with the appropriate webview URI.
  const filled = indexHtml.replace(
    /data-replace (src|href)="[^"]+"/g,
    match => {
      const i = match.indexOf(' ');
      const j = match.indexOf('=');
      const uri = getWebviewUri(match.slice(j + 2, -1).trim());
      return match.slice(i + 1, j) + '="' + uri.toString() + '"';
    }
  );

  return filled;
}

function getGraphStyle(): object {
  return vscode.workspace.getConfiguration('foam.graph').get('style');
}

function getShowFolders(): boolean {
  return vscode.workspace
    .getConfiguration('foam.graph')
    .get('showFolders', true);
}

function getExcludedFolders(): string[] {
  return vscode.workspace
    .getConfiguration('foam.graph')
    .get('excludedFolders', [] as string[]);
}

// Prefer repo/workspace folder name instead of '/'
function getFolderNameForDisplay(folderUri: any): string {
  try {
    const wsFolder = vscode.workspace.getWorkspaceFolder(toVsCodeUri(folderUri));
    const baseName = folderUri.getName();
    // If this folder is exactly the workspace root, show the workspace name
    if (wsFolder && folderUri.path === wsFolder.uri.path) {
      return wsFolder.name || baseName || '/';
    }
    return baseName || (wsFolder ? wsFolder.name : '/');
  } catch {
    return folderUri?.getName?.() || '/';
  }
}
