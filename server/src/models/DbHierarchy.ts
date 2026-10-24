import { createKey } from 'utils/hierarchy';
import { getDescription } from 'utils/misc';
import { contentTree, getDb, listProblemFiles, migrateLegacyCodeCache, reseedAlgorithms, seedAlgorithmsIfEmpty } from 'utils/db';
import { Type } from './Type';

// The content hierarchy, backed by the SQLite store (utils/db)
// instead of the filesystem working copies the app used before:
//
//   - Categories are the problems' tags, one category per tag; a
//     problem with several tags appears in each of them (its files
//     are shared; its code sessions stay per category because the
//     pad key contains the category key). Difficulty is NOT a tag:
//     it is metadata on the problem and rides along on each
//     algorithm entry as `difficulty`.
//   - The 'algorithm' root is seeded from the bundled algorithms/
//     content on first boot; the 'leetcode' root holds only what
//     the admin console imports.
//
// It exposes the same interface the controllers and the frontend
// middleware use (categories / find / iterate / refresh / update /
// toJSON) and serializes exactly like the old filesystem models.
class DbFile {
  constructor(public name: string, public content: string, public contributors: any[] = []) {
  }

  toJSON() {
    const {name, content, contributors} = this;
    return {name, content, contributors};
  }
}

class DbAlgorithm {
  constructor(public key: string, public name: string, public problemId: number, public difficulty: string | null = null) {
  }

  toJSON() {
    const {key, name, difficulty} = this;
    return {key, name, difficulty};
  }
}

class DbCategory {
  algorithms: DbAlgorithm[] = [];

  constructor(public key: string, public name: string, public type: Type) {
  }

  toJSON() {
    const {key, name, type, algorithms} = this;
    return {key, name, type, algorithms};
  }
}

const ROOTS: { root: string, type: Type }[] = [
  {root: 'algorithm', type: Type.ALGORITHM},
  {root: 'leetcode', type: Type.LEETCODE},
];

export class DbHierarchy {
  private categories: DbCategory[] = [];

  constructor() {
    getDb();
    migrateLegacyCodeCache();
    seedAlgorithmsIfEmpty();
    this.refresh();
  }

  refresh() {
    const categories: DbCategory[] = [];
    const usedKeys: { [key: string]: boolean } = {};
    for (const {root, type} of ROOTS) {
      for (const tree of contentTree(root)) {
        let key = createKey(tree.category);
        if (usedKeys[key]) {
          // A tag whose key collides with another root's category
          // (e.g. "String" on both sides) gets a root prefix so
          // routes and pad keys stay unambiguous.
          key = `${root}-${key}`;
          let suffix = 2;
          while (usedKeys[key]) key = `${root}-${createKey(tree.category)}-${suffix++}`;
        }
        usedKeys[key] = true;
        const category = new DbCategory(key, tree.category, type);
        category.algorithms = tree.algorithms.map(algorithm => new DbAlgorithm(algorithm.slug, algorithm.title, algorithm.id, algorithm.difficulty));
        categories.push(category);
      }
    }
    this.categories = categories;
  }

  // Kept for the webhook / admin callers of the old hierarchy:
  // "update" now means re-seed the algorithm root from the bundled
  // content and rebuild the in-memory tree.
  async update(): Promise<void> {
    reseedAlgorithms();
    this.refresh();
  }

  find(categoryKey: string, algorithmKey: string) {
    const category = this.categories.find(entry => entry.key === categoryKey);
    if (!category) return;
    const algorithm = category.algorithms.find(entry => entry.key === algorithmKey);
    if (!algorithm) return;
    const files = listProblemFiles(algorithm.problemId).map(file => new DbFile(file.name, file.content));
    const description = getDescription(files as any);
    return {
      categoryKey,
      categoryName: category.name,
      algorithmKey,
      algorithmName: algorithm.name,
      difficulty: algorithm.difficulty,
      files,
      description,
    };
  }

  iterate(callback: (category: DbCategory, algorithm: DbAlgorithm) => void) {
    this.categories.forEach(category => category.algorithms.forEach(algorithm => callback(category, algorithm)));
  }

  toJSON() {
    const {categories} = this;
    return {categories};
  }
}
