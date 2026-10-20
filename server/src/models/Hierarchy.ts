import path from 'path';
import { listDirectories } from 'utils/hierarchy';
import { GitHubApi } from 'utils/apis';
import { Algorithm, Category, File, Type } from 'models';
import { Author } from 'models/File';
import { algorithmsDir, leetcodeDir } from 'config/paths';
import { execute, pull } from 'utils/misc';

type CommitAuthors = {
  [sha: string]: Author,
}

export class Hierarchy {
  private categories!: Category[];
  readonly algorithmPath: string = algorithmsDir;
  readonly leetcodePath: string = leetcodeDir;

  constructor() {
    this.refresh();
    this.update().catch(console.error);
  }

  refresh() {
    this.categories = listDirectories(this.algorithmPath)
      .map(categoryName => new Category(path.resolve(this.algorithmPath, categoryName), categoryName, Type.ALGORITHM));
    
    this.categories.push(...listDirectories(this.leetcodePath)
      .map(categoryName => new Category(path.resolve(this.leetcodePath, categoryName), categoryName, Type.LEETCODE)))

    const files: File[] = [];
    this.categories.forEach(category => category.algorithms.forEach(algorithm => files.push(...algorithm.files)));
    this.cacheCommitAuthors().then(commitAuthors => this.cacheContributors(files, commitAuthors));
  }

  async update(commit?: string) {
    // Pull each content repo independently: one broken checkout (e.g. a
    // corrupt git index in the algorithms copy) must not stop the other
    // repo from updating or the refresh below from running.
    const pulls: [string, string][] = [
      [this.algorithmPath, 'algorithm-visualizer-content'],
      [this.leetcodePath, 'algorithm-visualizer-leetcode'],
    ];
    for (const [dir, repo] of pulls) {
      try {
        await pull(dir, repo, commit);
      } catch (error) {
        console.error(`Failed to update ${repo}:`, error);
      }
    }
    this.refresh();
  };

  async cacheCommitAuthors(page = 1, commitAuthors: CommitAuthors = {}): Promise<CommitAuthors> {
    const per_page = 100;
    const {data} = await GitHubApi.listCommits('algorithm-visualizer', 'algorithms', {per_page, page});
    const commits: any[] = data;
    for (const {sha, author} of commits) {
      if (!author) continue;
      const {login, avatar_url} = author;
      commitAuthors[sha] = {login, avatar_url};
    }
    if (commits.length < per_page) {
      return commitAuthors;
    } else {
      return this.cacheCommitAuthors(page + 1, commitAuthors);
    }
  }

  async cacheContributors(files: File[], commitAuthors: CommitAuthors) {
    for (const file of files) {
      const stdout = await execute(`git --no-pager log --follow --no-merges --format="%H" -- "${path.relative(this.algorithmPath, file.path)}"`, {
        cwd: this.algorithmPath,
      });
      const output = stdout.toString().replace(/\n$/, '');
      const shas = output.split('\n').reverse();
      const contributors: Author[] = [];
      for (const sha of shas) {
        const author = commitAuthors[sha];
        if (author && !contributors.find(contributor => contributor.login === author.login)) {
          contributors.push(author);
        }
      }
      file.contributors = contributors;
    }
  }

  find(categoryKey: string, algorithmKey: string) {
    const category = this.categories.find(category => category.key === categoryKey);
    if (!category) return;
    const algorithm = category.algorithms.find(algorithm => algorithm.key === algorithmKey);
    if (!algorithm) return;

    const categoryName = category.name;
    const algorithmName = algorithm.name;
    const files = algorithm.files;
    const description = algorithm.description;

    return {categoryKey, categoryName, algorithmKey, algorithmName, files, description};
  }

  iterate(callback: (category: Category, algorithm: Algorithm) => void) {
    this.categories.forEach(category => category.algorithms.forEach(algorithm => callback(category, algorithm)));
  }

  toJSON() {
    const {categories} = this;
    return {categories};
  }
}
