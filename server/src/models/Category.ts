import path from 'path';
import { createKey, listDirectories } from 'utils/hierarchy';
import { Algorithm } from 'models';
import { Type } from './Type';

export class Category {
  key: string;
  type: Type;
  algorithms!: Algorithm[];

  constructor(private path: string, public name: string, public contentType: Type) {
    this.key = createKey(name);
    this.type = contentType;
    this.refresh();
  }

  refresh() {
    this.algorithms = listDirectories(this.path)
      .map(algorithmName => new Algorithm(path.resolve(this.path, algorithmName), algorithmName));
  }

  toJSON() {
    const {key, name, type, algorithms} = this;
    return {key, name, type, algorithms};
  }
}

export default Category;
