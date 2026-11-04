import type { MaterialSource } from "../protocol";

export const MATERIAL_CATEGORY_LABELS: Record<MaterialSource, string> = {
  official: "官方样题",
  cambridge: "剑桥真题",
  publisher: "其他出版材料",
  unofficial: "非官方材料",
};

export function OfficialResources() {
  return (
    <section className="panel" aria-label="官方练习资源">
      <h2 className="eyebrow">官方练习资源</h2>
      <p>熟悉机考操作和官方题型；打开链接不会自动导入材料或登记成绩。</p>
      <ul>
        <li>
          <a
            href="https://takeielts.britishcouncil.org/prepare/ielts-free-practice-mock-tests/ielts-familiarisation-test"
            target="_blank"
            rel="noreferrer"
          >
            英国文化教育协会：雅思机考熟悉测试
          </a>
        </li>
        <li>
          <a
            href="https://ielts.org/take-a-test/preparation-resources/sample-test-questions/academic-test"
            target="_blank"
            rel="noreferrer"
          >
            雅思官方：学术类样题与机考体验
          </a>
        </li>
      </ul>
    </section>
  );
}
