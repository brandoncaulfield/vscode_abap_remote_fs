import { Uri } from "vscode"
import { AdtConnection } from "../adt/AdtConnection"
import { pick } from "../functions"

export type AbapComponents = Array<{
  name: string
  types: Array<{ name: string; objects: Array<AbapObject> }>
}>

export class AbapObjectName {
  namespace: string
  name: string
  vsName(): string {
    return this.namespace === ""
      ? this.name
      : `／${this.namespace}／${this.name}`
  }
  abapName(): string {
    return this.namespace === "" ? this.name : `/${this.namespace}/${this.name}`
  }
  constructor(fullname: string) {
    const parts = fullname.replace(/／/g, "/").match(/^\/([^\/]*)\/(.*)/)
    if (parts) {
      this.namespace = parts[1]
      this.name = parts[2]
    } else {
      this.name = fullname
      this.namespace = ""
    }
  }
}

export class AbapObject {
  type: string
  name: string
  path: string

  constructor(type: string, name: string, path: string) {
    this.name = name
    this.type = type
    this.path = path
  }

  isLeaf() {
    return true
  }
  vsName(): string {
    return this.name.replace(/\//g, "／") + this.getExtension()
  }

  getContents(connection: AdtConnection): Promise<string> {
    const uri = Uri.parse("adt://" + connection.name).with({
      path: this.path + "/source/main"
    })
    return connection.request(uri, "GET").then(pick("body"))
  }

  getExtension(): any {
    return this.isLeaf() ? ".abap" : ""
  }
  getChildren(connection: AdtConnection): Promise<AbapComponents> {
    throw new Error("Method not implemented.")
  }
}
