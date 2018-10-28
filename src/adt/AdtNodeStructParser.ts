import { getNode, recxml2js, parsetoPromise } from "./AdtParserBase"

import {
  mapWidth,
  ArrayToMap,
  filterComplex,
  defaultVal,
  GroupArray,
  selectMap
} from "../functions"
import { fromObjectNode } from "../abap/AbapObjectFactory"
import { convertableToString } from "xml2js"
import { AbapNodeComponentByCategory } from "../abap/AbapObject"

export interface ObjectNode {
  OBJECT_TYPE: string
  OBJECT_NAME: string
  TECH_NAME: string
  OBJECT_URI: string
  OBJECT_VIT_URI: string
  EXPANDABLE: string
}

interface CategoryNode {
  CATEGORY: string
  CATEGORY_LABEL: string
}

interface ObjectTypeNode {
  OBJECT_TYPE: string
  CATEGORY_TAG: string
  OBJECT_TYPE_LABEL: string
  NODE_ID: string
}

const treecontentParser = defaultVal(
  [],
  getNode(
    "asx:abap/asx:values/DATA/TREE_CONTENT/SEU_ADT_REPOSITORY_OBJ_NODE",
    filterComplex(true),
    mapWidth(recxml2js)
  )
) as (xml: string) => Array<ObjectNode>
const categoryNodeParser: (a: string) => Map<string, CategoryNode> = defaultVal(
  new Map(),
  getNode(
    "asx:abap/asx:values/DATA/CATEGORIES",
    filterComplex(true),
    "SEU_ADT_OBJECT_CATEGORY_INFO",
    mapWidth(recxml2js),
    ArrayToMap("CATEGORY")
  )
)

const ObjectTypeParser: (a: string) => Map<string, ObjectTypeNode> = defaultVal(
  new Map(),
  getNode(
    "asx:abap/asx:values/DATA/OBJECT_TYPES",
    filterComplex(true),
    "SEU_ADT_OBJECT_TYPE_INFO",
    mapWidth(recxml2js),
    ArrayToMap("OBJECT_TYPE")
  )
)

export const parseNodeStructure: (
  rawpayload: convertableToString
) => Promise<Array<AbapNodeComponentByCategory>> = parsetoPromise(
  (payload: any) => {
    const nodes = treecontentParser(payload)
    const categories = categoryNodeParser(payload)
    const objectTypes = ObjectTypeParser(payload)

    const catLabel = selectMap(categories, "CATEGORY_LABEL", "")
    const typeLabel = selectMap(objectTypes, "OBJECT_TYPE_LABEL", "")

    const types = GroupArray("OBJECT_TYPE")(nodes)
    const catTypes = GroupArray("CATEGORY_TAG")([...objectTypes.values()])

    const components: Array<AbapNodeComponentByCategory> = []
    for (const [category, ctypes] of catTypes) {
      const cat = {
        name: catLabel(category),
        category,
        types: new Array<any>()
      }
      components.push(cat)
      for (const ctype of ctypes) {
        const typerec = types.get(ctype.OBJECT_TYPE)
        if (typerec)
          cat.types.push({
            name: typeLabel(ctype.OBJECT_TYPE),
            type: ctype.OBJECT_TYPE,
            objects: typerec.map(fromObjectNode)
          })
      }
    }
    //root node has no categories, just a list of packages
    if (catTypes.size === 0)
      components.push({
        name: "",
        category: "",
        types: [{ name: "", type: "", objects: nodes.map(fromObjectNode) }]
      })

    return components
  }
)