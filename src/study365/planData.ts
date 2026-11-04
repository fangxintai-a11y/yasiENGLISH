import rulesData from "../../public/curriculum365/v1/plan-rules.json";
import inventoryData from "../../public/curriculum365/v1/inventory.json";
import materialData from "../../public/curriculum365/v1/samples.json";
export type PlanRules = typeof rulesData;
export type PlanInventory = typeof inventoryData;
export type PlanExternalReference = PlanInventory["externalReferences"][number];
export type PlanMaterial = { id: string; version: string; skill: string; title: string; reviewStatus: string };
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
/** Static imports are part of the application bundle and require no request. */
export const bundledRules: PlanRules = freeze(rulesData);
export const bundledInventory: PlanInventory = freeze(inventoryData);
export const bundledMaterials: PlanMaterial[] = freeze(materialData.materials.map((material) => ({ id: material.id, version: material.version, skill: material.skill, title: material.title, reviewStatus: material.source.reviewStatus })));
