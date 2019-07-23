import { showInGui } from "./../adt/sapgui/sapgui"
import { PACKAGE } from "../adt/operations/AdtObjectCreator"
import { AbapRevision } from "../scm/abaprevision"
import { AdtServer, getOrCreateServer } from "../adt/AdtServer"
import {
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  workspace,
  Uri,
  EventEmitter,
  window,
  ProgressLocation,
  commands,
  env
} from "vscode"
import { ADTSCHEME, fromUri } from "../adt/AdtServer"
import {
  TransportTarget,
  TransportRequest,
  TransportTask,
  TransportObject,
  ADTClient,
  TransportReleaseReport,
  SAPRC
} from "abap-adt-api"
import { command, AbapFsCommands } from "../commands"
import { isAbapNode } from "../fs/AbapNode"
import {
  findMainIncludeAsync,
  allChildren,
  NodePath
} from "../adt/abap/AbapObjectUtilities"
import { withp } from "../functions"
import { SapGuiCommand } from "../adt/sapgui/sapgui"

const currentUsers = new Map<string, string>()

class CollectionItem extends TreeItem {
  protected children: CollectionItem[] = []
  constructor(label: string) {
    super(label, TreeItemCollapsibleState.Expanded)
  }
  public addChild(child: CollectionItem) {
    this.children.push(child)
  }

  public async getChildren() {
    return this.children
  }
}

// tslint:disable: max-classes-per-file
class ConnectionItem extends CollectionItem {
  private get user() {
    const server = fromUri(this.uri)
    return currentUsers.get(server.connectionId) || server.client.username
  }

  public get label() {
    return `${this.uri.authority.toUpperCase()} Transport of ${this.user.toUpperCase()}`
  }

  public set label(l: string) {
    // will never change
  }

  constructor(public uri: Uri) {
    super(uri.authority.toUpperCase())
    this.contextValue = "tr_connection"
  }

  public async getChildren() {
    if (this.children.length === 0 && !!this.uri) {
      const server = fromUri(this.uri)
      const transports = await server.client.userTransports(this.user)

      for (const cat of ["workbench", "customizing"]) {
        const targets = (transports as any)[cat] as TransportTarget[]
        if (!targets.length) continue
        const coll = new CollectionItem(cat)
        for (const target of targets)
          coll.addChild(new TargetItem(target, server))
        this.children.push(coll)
      }
    }
    return this.children
  }
}

class TargetItem extends CollectionItem {
  constructor(target: TransportTarget, server: AdtServer) {
    super(`${target["tm:name"]} ${target["tm:desc"]}`)

    for (const cat of ["modifiable", "released"]) {
      const transports = (target as any)[cat] as TransportRequest[]
      if (!transports.length) continue
      const coll = new CollectionItem(cat)
      for (const transport of transports)
        coll.addChild(new TransportItem(transport, server))
      this.children.push(coll)
    }
  }
}

function isTransport(task: TransportTask): task is TransportRequest {
  return !!(task as any).tasks
}

const failuretext = (failure: TransportReleaseReport) =>
  failure.messages
    .filter(m => m["chkrun:type"] === SAPRC.Error)
    .map(m => m["chkrun:shortText"])
    .join(" ") || failure["chkrun:statusText"]

class TransportItem extends CollectionItem {
  public static isA(x: any): x is TransportItem {
    return x && (x as TransportItem).typeId === TransportItem.tranTypeId
  }
  private static tranTypeId = Symbol()
  @command(AbapFsCommands.releaseTransport)
  private static async releaseTransport(tran: TransportItem) {
    try {
      const transport = tran.task["tm:number"]
      await window.withProgress(
        { location: ProgressLocation.Window, title: `Releasing ${transport}` },
        async () => {
          // before releasing the main transports, release subtasks if
          //  - not released
          //  - not empty
          const tasks = tran.children.filter(
            c => TransportItem.isA(c) && c.children.length && !c.released
          )
          // append main transport as last
          tasks.push(tran)
          for (const task of tasks) {
            if (!TransportItem.isA(task)) continue // just to make ts happy
            const reports = await task.server.client.transportRelease(
              task.task["tm:number"]
            )
            const failure = reports.find(r => r["chkrun:status"] !== "released")
            if (failure) {
              throw new Error(
                `${transport} not released: ${failuretext(failure)}`
              )
            }
          }
        }
      )
      commands.executeCommand(AbapFsCommands.refreshtransports)
    } catch (e) {
      window.showErrorMessage(e.toString())
    }
  }
  public readonly typeId: symbol

  public get released() {
    return !this.task["tm:status"].match(/[DL]/)
  }

  public get contextValue() {
    return this.released ? "tr_released" : "tr_unreleased"
  }

  constructor(
    public task: TransportTask,
    public server: AdtServer,
    public transport?: TransportItem
  ) {
    super(`${task["tm:number"]} ${task["tm:owner"]} ${task["tm:desc"]}`)
    this.typeId = TransportItem.tranTypeId
    this.collapsibleState = TreeItemCollapsibleState.Collapsed
    if (isTransport(task))
      for (const subTask of task.tasks) {
        this.addChild(new TransportItem(subTask, server, this))
      }
    for (const obj of task.objects) {
      this.addChild(new ObjectItem(obj, server, this))
    }
  }

  public get revisionFilter(): RegExp {
    if (this.transport) return this.transport.revisionFilter
    const trChildren = this.children.filter(TransportItem.isA)
    return RegExp(
      [this, ...trChildren].map(ti => ti.task["tm:number"]).join("|")
    )
  }
}

class ObjectItem extends CollectionItem {
  public static isA(x: any): x is ObjectItem {
    return x && (x as ObjectItem).typeId === ObjectItem.objTypeId
  }
  private static objTypeId = Symbol()
  public readonly typeId: symbol
  constructor(
    public readonly obj: TransportObject,
    public readonly server: AdtServer,
    public readonly transport: TransportItem
  ) {
    super(`${obj["tm:pgmid"]} ${obj["tm:type"]} ${obj["tm:name"]}`)
    this.typeId = ObjectItem.objTypeId
    this.collapsibleState = TreeItemCollapsibleState.None
    this.contextValue = "tr_object"
    if (obj["tm:pgmid"].match(/(LIMU)|(R3TR)/))
      this.command = {
        title: "Open",
        command: AbapFsCommands.openTransportObject,
        arguments: [this.obj, this.server]
      }
  }

  public sameObj(other: ObjectItem) {
    const oo = other.obj
    const to = this.obj
    return (
      oo["tm:pgmid"] === to["tm:pgmid"] &&
      oo["tm:type"] === to["tm:type"] &&
      oo["tm:name"] === to["tm:name"]
    )
  }
}

export class TransportsProvider implements TreeDataProvider<CollectionItem> {
  public static get() {
    if (!this.instance) {
      const instance = new TransportsProvider()
      this.instance = instance
      workspace.onDidChangeWorkspaceFolders(() => instance.refresh())
      instance.refresh()
    }
    return this.instance
  }

  private static instance?: TransportsProvider

  public get onDidChangeTreeData() {
    return this.emitter.event
  }

  private root = this.newRoot()
  private emitter = new EventEmitter<CollectionItem>()

  public getTreeItem(element: CollectionItem): TreeItem | Thenable<TreeItem> {
    return element || this.root
  }
  public getChildren(
    element?: CollectionItem | undefined
  ): import("vscode").ProviderResult<CollectionItem[]> {
    if (element) return element.getChildren()
    return this.root.getChildren()
  }

  public async refresh() {
    const root = this.newRoot()

    const folders = (workspace.workspaceFolders || []).filter(
      f => f.uri.scheme === ADTSCHEME
    )
    for (const f of folders) {
      const server = await getOrCreateServer(f.uri.authority)
      const hasTR = await server.client.featureDetails(
        "Change and Transport System"
      )
      if (
        hasTR &&
        hasTR.collection.find(
          c => c.href === "/sap/bc/adt/cts/transportrequests"
        )
      )
        root.addChild(new ConnectionItem(f.uri))
    }
    this.root = root
    this.emitter.fire()
  }

  private newRoot() {
    return new CollectionItem("root")
  }

  // tslint:disable: member-ordering
  private static async decodeTransportObject(
    obj: TransportObject,
    server: AdtServer,
    main = true
  ) {
    if (!obj || !server) return
    let url
    try {
      url = await server.client.transportReference(
        obj["tm:pgmid"],
        obj["tm:type"],
        obj["tm:name"]
      )
    } catch (e) {
      return
    }
    try {
      const steps = await server.objectFinder.findObjectPath(url)
      const path = await server.objectFinder.locateObject(steps)
      if (!path) return
      if (!main || !path.node.isFolder) return path

      if (
        isAbapNode(path.node) &&
        path.node.abapObject.type.match(/(CLAS)|(PROG)/)
      )
        return await findMainIncludeAsync(path, server.client)
    } catch (e) {
      throw new Error(
        `Error locating object ${obj["tm:pgmid"]} ${obj["tm:type"]} ${
          obj["tm:name"]
        }: ${e.toString()}`
      )
    }
  }

  @command(AbapFsCommands.transportObjectDiff)
  private static async openTransportObjectDiff(item: ObjectItem) {
    let displayed = false
    try {
      await withp("Opening diff...", async () => {
        const path = await this.decodeTransportObject(item.obj, item.server)
        if (!path || !path.path || !isAbapNode(path.node)) return
        const uri = item.server.createUri(path.path)
        const obj = path.node.abapObject
        if (!obj.structure) await obj.loadMetadata(item.server.client)
        if (!obj.structure) return

        const revisions = await item.server.client.revisions(obj.structure)
        const beforeTr = revisions.find(
          r => !r.version.match(item.transport.revisionFilter)
        )
        if (!beforeTr) return
        displayed = true
        return AbapRevision.displayDiff(uri, beforeTr)
      })
      if (!displayed) window.showInformationMessage("Object not found")
    } catch (e) {
      window.showErrorMessage(
        `Error displaying transport object: ${e.toString}`
      )
    }
  }

  @command(AbapFsCommands.openTransportObject)
  private static async openTransportObject(
    obj: TransportObject,
    server: AdtServer
  ) {
    let displayed = false
    try {
      await withp("Opening object...", async () => {
        const path = await this.decodeTransportObject(obj, server)
        if (!path || !path.path) return
        const uri = Uri.parse("adt://foo/").with({
          authority: server.connectionId,
          path: path.path
        })

        const document = await workspace.openTextDocument(uri)
        displayed = true
        return window.showTextDocument(document, {
          preserveFocus: false
        })
      })
      if (!displayed) window.showInformationMessage("Object not found")
    } catch (e) {
      window.showErrorMessage(
        `Error displaying transport object: ${e.toString}`
      )
    }
  }

  @command(AbapFsCommands.deleteTransport)
  private static async deleteTransport(tran: TransportItem) {
    try {
      await tran.server.client.transportDelete(tran.task["tm:number"])
      this.refreshTransports()
    } catch (e) {
      window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.refreshtransports)
  private static async refreshTransports() {
    TransportsProvider.get().refresh()
  }

  private static async pickUser(client: ADTClient) {
    const users = (await client.systemUsers()).map(u => ({
      label: u.title,
      description: u.id,
      payload: u
    }))
    const selected = await window.showQuickPick(users)
    return selected && selected.payload
  }

  @command(AbapFsCommands.transportOwner)
  private static async transportOwner(tran: TransportItem) {
    try {
      const selected = await this.pickUser(tran.server.client)
      if (selected && selected.id !== tran.task["tm:owner"]) {
        await tran.server.client.transportSetOwner(
          tran.task["tm:number"],
          selected.id
        )
        this.refreshTransports()
      }
    } catch (e) {
      window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.transportOpenGui)
  private static openTransportInGui(tran: TransportItem) {
    return showInGui(tran.server, tran.task["tm:uri"])
  }

  @command(AbapFsCommands.transportCopyNumber)
  private static copyTransportNumber(tran: TransportItem) {
    env.clipboard.writeText(tran.task["tm:number"])
  }

  @command(AbapFsCommands.transportAddUser)
  private static async transportAddUser(tran: TransportItem) {
    try {
      const selected = await this.pickUser(tran.server.client)
      if (selected && selected.id !== tran.task["tm:owner"]) {
        await tran.server.client.transportAddUser(
          tran.task["tm:number"],
          selected.id
        )
        this.refreshTransports()
      }
    } catch (e) {
      window.showErrorMessage(e.toString())
    }
  }

  @command(AbapFsCommands.transportRevision)
  private static async transportRevision(tran: TransportItem) {
    const transport = tran.task["tm:number"]
    const children = await tran.getChildren()
    // find the objects in transports and subtasks
    const trobjects = children.filter(ObjectItem.isA)
    for (const child of children.filter(TransportItem.isA)) {
      const gc = await child.getChildren()
      for (const obj of gc.filter(ObjectItem.isA))
        if (!trobjects.find(o => o.sameObj(obj))) trobjects.push(obj)
    }

    if (!trobjects.length) return

    const paths: NodePath[] = []
    const addNode = async (node: NodePath) => {
      if (isAbapNode(node.node) && node.node.abapObject.canBeWritten) {
        if (paths.find(p => p.path === node.path)) return
        paths.push(node)
        await AbapRevision.get().addTransport(
          tran.label || transport,
          tran.server,
          [node],
          tran.revisionFilter
        )
      }
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        cancellable: true,
        title: `Creating scm group for transport ${transport}`
      },
      async (progress, token) => {
        for (const tro of trobjects) {
          if (token.isCancellationRequested) return
          progress.report({ increment: (1 * 100) / trobjects.length })
          try {
            const path = await this.decodeTransportObject(
              tro.obj,
              tro.server,
              false
            )
            if (!path) continue
            if (path.node.isFolder) {
              // expand folders to children
              if (!isAbapNode(path.node)) continue
              const obj = path.node.abapObject
              // for packages we don't really care about contents
              if (obj.type === PACKAGE) continue
              let components = allChildren(path)
              if (components.length === 0) {
                await path.node.refresh(tro.server.client)
                components = allChildren(path)
              }
              for (const child of allChildren(path)) await addNode(child)
            } else await addNode(path)
          } catch (e) {
            window.showErrorMessage(e.toString())
          }
        }
      }
    )
  }

  @command(AbapFsCommands.transportUser)
  private static async transportSelectUser(conn: ConnectionItem) {
    const server = fromUri(conn.uri)
    if (!server) return
    const selected = await this.pickUser(server.client)

    if (!selected) return

    if (currentUsers.get(server.connectionId) === selected.id) return

    currentUsers.set(server.connectionId, selected.id)
    this.refreshTransports()
  }
}
