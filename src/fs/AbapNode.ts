import { ADTClient } from "abap-adt-api"
import { FileStat, FileType, FileSystemError } from "vscode"
import { aggregateNodes } from "../adt/abap/AbapObjectUtilities"
import { AbapObject, AbapNodeComponentByCategory } from "../adt/abap/AbapObject"
import { MetaFolder } from "./MetaFolder"
import { flatMap, pick } from "../functions"

export const dummy = () => !!aggregateNodes //hack to fix circular dependency issue

const getNodeHierarchyByType = (
  components: Array<AbapNodeComponentByCategory>
): MetaFolder => {
  const newNode = new MetaFolder()
  const flatComp = flatMap(components, pick("types"))
  flatComp.forEach(otype => {
    const curNode = otype.name
      ? newNode.setChild(otype.name, new MetaFolder())
      : newNode
    otype.objects.forEach(o =>
      curNode.setChild(o.vsName, new AbapObjectNode(o))
    )
  })
  return newNode
}

const getNodeHierarchy = (
  components: Array<AbapNodeComponentByCategory>
): MetaFolder => {
  const newNode = new MetaFolder()
  components.forEach(category => {
    let categFolder: MetaFolder
    category.types.forEach(otype => {
      let tpFolder: AbapNode
      if (otype.type.match("DEVC") || otype.type === "") tpFolder = newNode
      else {
        categFolder = categFolder || new MetaFolder()
        tpFolder =
          !otype.name || otype.name === category.name
            ? categFolder
            : categFolder.setChild(otype.name, new MetaFolder())
      }
      otype.objects.forEach(obj =>
        tpFolder.setChild(obj.vsName, new AbapObjectNode(obj))
      )
      if (categFolder) newNode.setChild(category.name, categFolder)
    })
  })
  return newNode
}
const refreshObjects = (
  node: AbapObjectNode,
  components: Array<AbapNodeComponentByCategory>
): void => {
  //create a new structure, then will match it with the node's
  const newFolder = node.abapObject.type.match(/DEVC/)
    ? getNodeHierarchy(components)
    : getNodeHierarchyByType(components)

  function reconcile(current: AbapNode, newNode: AbapNode) {
    //remove deleted objects from node
    ;[...current]
      .filter(x => !newNode.getChild(x[0]))
      .forEach(x => current.deleteChild(x[0]))

    for (const [name, value] of [...newNode]) {
      const oldChild = current.getChild(name)
      if (!oldChild) current.setChild(name, value)
      else if (oldChild.isFolder) reconcile(oldChild, value)
    }
  }

  reconcile(node, newFolder)
}

//folders are only used to store other nodes
export class AbapObjectNode implements FileStat, Iterable<[string, AbapNode]> {
  abapObject: AbapObject
  type: FileType
  ctime: number = Date.now()
  mtime: number = Date.now()
  size: number = 0
  private children?: Map<string, AbapNode>

  constructor(abapObject: AbapObject) {
    if (abapObject.isLeaf()) this.type = FileType.File
    else {
      this.type = FileType.Directory
      this.children = new Map()
    }
    this.abapObject = abapObject
  }

  public get isFolder() {
    return !this.abapObject.isLeaf()
  }
  public getChild(name: string): AbapNode | undefined {
    if (!this.children || !this.isFolder)
      throw FileSystemError.FileNotADirectory(name)
    return this.children.get(name)
  }
  public setChild(name: string, child: AbapNode): AbapNode {
    if (!this.children || !this.isFolder)
      throw FileSystemError.FileNotADirectory(name)
    this.children.set(name, child)
    this.mtime = Date.now()
    return child
  }
  public deleteChild(name: string): void {
    if (!this.children || !this.isFolder)
      throw FileSystemError.FileNotADirectory(name)
    this.mtime = Date.now()
    this.children.delete(name)
  }
  get numChildren(): number {
    return this.children ? this.children.size : 0
  }
  public async fetchContents(client: ADTClient): Promise<Uint8Array> {
    if (this.isFolder) return Promise.reject(FileSystemError.FileIsADirectory())

    try {
      const payload = await this.abapObject.getContents(client)
      const buf = Buffer.from(payload)
      this.size = buf.length
      return buf
    } catch (e) {
      return Promise.reject(e)
    }
  }

  public async refresh(client: ADTClient): Promise<AbapNode> {
    const children = await this.abapObject.getChildren(client)
    refreshObjects(this, children)
    return this
  }

  public async stat(client: ADTClient): Promise<AbapNode> {
    await this.abapObject.loadMetadata(client)
    const meta = this.abapObject.structure
    if (meta) {
      this.ctime = meta.metaData["adtcore:createdAt"].getTime()
      this.mtime = meta.metaData["adtcore:changedAt"].getTime()
    }
    return this
  }

  public canRefresh() {
    return true
  }

  [Symbol.iterator]() {
    if (!this.children) throw FileSystemError.FileNotADirectory()
    return this.children[Symbol.iterator]()
  }
}

export type AbapNode = AbapObjectNode | MetaFolder
export function isAbapNode(node: AbapNode): node is AbapObjectNode {
  return (<AbapObjectNode>node).abapObject !== undefined
}
