/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

'use strict';

const {EventEmitter} = require('events');

import type Bundler, {BundlingOptions} from '../Bundler';
import type {Options as JSTransformerOptions} from '../JSTransformer/worker';
import type Resolver from '../Resolver';
import type {BundleOptions} from '../Server';
import type ResolutionResponse from '../node-haste/DependencyGraph/ResolutionResponse';
import type Module from '../node-haste/Module';

export type DeltaResult = {|
  +modified: Map<string, Module>,
  +deleted: Set<string>,
  +reset: boolean,
|};

/**
 * This class is in charge of calculating the delta of changed modules that
 * happen between calls. To do so, it subscribes to file changes, so it can
 * traverse the files that have been changed between calls and avoid having to
 * traverse the whole dependency tree for trivial small changes.
 */
class DeltaCalculator extends EventEmitter {
  _bundler: Bundler;
  _resolver: Resolver;
  _options: BundleOptions;
  _transformerOptions: ?JSTransformerOptions;

  _dependencies: Set<string> = new Set();
  _shallowDependencies: Map<string, Set<string>> = new Map();
  _modifiedFiles: Set<string> = new Set();
  _currentBuildPromise: ?Promise<DeltaResult>;
  _dependencyPairs: Map<string, $ReadOnlyArray<[string, Module]>> = new Map();
  _modulesByName: Map<string, Module> = new Map();
  _inverseDependencies: Map<string, Set<string>> = new Map();

  constructor(bundler: Bundler, resolver: Resolver, options: BundleOptions) {
    super();

    this._bundler = bundler;
    this._options = options;
    this._resolver = resolver;

    this._resolver
      .getDependencyGraph()
      .getWatcher()
      .on('change', this._handleMultipleFileChanges);
  }

  /**
   * Stops listening for file changes and clears all the caches.
   */
  end() {
    this._resolver
      .getDependencyGraph()
      .getWatcher()
      .removeListener('change', this._handleMultipleFileChanges);

    // Clean up all the cache data structures to deallocate memory.
    this._dependencies = new Set();
    this._shallowDependencies = new Map();
    this._modifiedFiles = new Set();
    this._dependencyPairs = new Map();
    this._modulesByName = new Map();
  }

  /**
   * Main method to calculate the delta of modules. It returns a DeltaResult,
   * which contain the modified/added modules and the removed modules.
   */
  async getDelta(): Promise<DeltaResult> {
    // If there is already a build in progress, wait until it finish to start
    // processing a new one (delta server doesn't support concurrent builds).
    if (this._currentBuildPromise) {
      await this._currentBuildPromise;
    }

    // We don't want the modified files Set to be modified while building the
    // bundle, so we isolate them by using the current instance for the bundling
    // and creating a new instance for the file watcher.
    const modifiedFiles = this._modifiedFiles;
    this._modifiedFiles = new Set();

    // Concurrent requests should reuse the same bundling process. To do so,
    // this method stores the promise as an instance variable, and then it's
    // removed after it gets resolved.
    this._currentBuildPromise = this._getDelta(modifiedFiles);

    let result;

    try {
      result = await this._currentBuildPromise;
    } catch (error) {
      // In case of error, we don't want to mark the modified files as
      // processed (since we haven't actually created any delta). If we do not
      // do so, asking for a delta after an error will produce an empty Delta,
      // which is not correct.
      modifiedFiles.forEach(file => this._modifiedFiles.add(file));

      throw error;
    } finally {
      this._currentBuildPromise = null;
    }

    return result;
  }

  /**
   * Returns the options options object that is used by ResoltionRequest to
   * read all the modules. This can be used by external objects to read again
   * any module very fast (since the options object instance will be the same).
   */
  getTransformerOptions(): JSTransformerOptions {
    if (!this._transformerOptions) {
      throw new Error('Calculate a bundle first');
    }
    return this._transformerOptions;
  }

  /**
   * Returns all the dependency pairs for each of the modules. Each dependency
   * pair consists of a string which corresponds to the relative path used in
   * the `require()` statement and the Module object for that dependency.
   */
  getDependencyPairs(): Map<string, $ReadOnlyArray<[string, Module]>> {
    return this._dependencyPairs;
  }

  /**
   * Returns a map of module names to Module objects (module name being the
   * result of calling `Module.getName()`).
   */
  getModulesByName(): Map<string, Module> {
    return this._modulesByName;
  }

  getInverseDependencies(): Map<string, Set<string>> {
    return this._inverseDependencies;
  }

  _handleMultipleFileChanges = ({eventsQueue}) => {
    eventsQueue.forEach(this._handleFileChange);
  };

  /**
   * Handles a single file change. To avoid doing any work before it's needed,
   * the listener only stores the modified file, which will then be used later
   * when the delta needs to be calculated.
   */
  _handleFileChange = ({
    type,
    filePath,
  }: {
    type: string,
    filePath: string,
  }): mixed => {
    // We do not want to keep track of deleted files, since this can cause
    // issues when moving files (or even deleting files).
    // The only issue with this approach is that the user removes a file that
    // is needed, the bundler will still create a correct bundle (since it
    // won't detect any modified file). Once we have our own dependency
    // traverser in Delta Bundler this will be easy to fix.
    if (type === 'delete') {
      this._dependencies.delete(filePath);
      return;
    }

    this._modifiedFiles.add(filePath);

    // Notify users that there is a change in some of the bundle files. This
    // way the client can choose to refetch the bundle.
    if (this._dependencies.has(filePath)) {
      this.emit('change');
    }
  };

  async _getDelta(modifiedFiles: Set<string>): Promise<DeltaResult> {
    // If we call getDelta() without being initialized, we need get all
    // dependencies and return a reset delta.
    if (this._dependencies.size === 0) {
      const {added} = await this._calculateAllDependencies();

      return {
        modified: added,
        deleted: new Set(),
        reset: true,
      };
    }

    // We don't care about modified files that are not depended in the bundle.
    // If any of these files is required by an existing file, it will
    // automatically be picked up when calculating all dependencies.
    const modifiedArray = Array.from(modifiedFiles).filter(file =>
      this._dependencies.has(file),
    );

    // No changes happened. Return empty delta.
    if (modifiedArray.length === 0) {
      return {modified: new Map(), deleted: new Set(), reset: false};
    }

    // Build the modules from the files that have been modified.
    const modified = new Map(
      modifiedArray.map(file => {
        const module = this._resolver.getModuleForPath(file);
        return [file, module];
      }),
    );

    const filesWithChangedDependencies = await Promise.all(
      modifiedArray.map(this._hasChangedDependencies, this),
    );

    // If there is no file with changes in its dependencies, we can just
    // return the modified modules without recalculating the dependencies.
    if (!filesWithChangedDependencies.some(value => value)) {
      return {modified, deleted: new Set(), reset: false};
    }

    // Recalculate all dependencies and append the newly added files to the
    // modified files.
    const {added, deleted} = await this._calculateAllDependencies();

    for (const [key, value] of added) {
      modified.set(key, value);
    }

    return {
      modified,
      deleted,
      reset: false,
    };
  }

  async _hasChangedDependencies(file: string) {
    const module = this._resolver.getModuleForPath(file);

    if (!this._dependencies.has(module.path)) {
      return false;
    }

    const newDependencies = await this._getShallowDependencies(module);
    const oldDependencies = this._shallowDependencies.get(module.path);

    if (!oldDependencies) {
      return false;
    }

    // Update the dependency and inverse dependency caches for this module.
    this._shallowDependencies.set(module.path, newDependencies);

    return areDifferent(oldDependencies, newDependencies);
  }

  async _calculateAllDependencies(): Promise<{
    added: Map<string, Module>,
    deleted: Set<string>,
  }> {
    const added = new Map();

    const response = await this._getAllDependencies();
    const currentDependencies = response.dependencies;

    this._transformerOptions = response.options.transformer;

    currentDependencies.forEach(module => {
      const dependencyPairs = response.getResolvedDependencyPairs(module);

      this._shallowDependencies.set(
        module.path,
        new Set(dependencyPairs.map(([name, module]) => name)),
      );
      this._dependencyPairs.set(module.path, dependencyPairs);

      // Only add it to the delta bundle if it did not exist before.
      if (!this._dependencies.has(module.path)) {
        added.set(module.path, module);
        this._dependencies.add(module.path);
      }
    });

    const deleted = new Set();

    // We know that some files have been removed only if the size of the current
    // dependencies is different that the size of the old dependencies after
    // adding the new files.
    if (currentDependencies.length !== this._dependencies.size) {
      const currentSet = new Set(currentDependencies.map(dep => dep.path));

      this._dependencies.forEach(file => {
        if (currentSet.has(file)) {
          return;
        }

        this._dependencies.delete(file);
        this._shallowDependencies.delete(file);
        this._dependencyPairs.delete(file);

        deleted.add(file);
      });
    }

    // Last iteration through all dependencies to populate the modulesByName
    // cache (we could get rid of this if the `runBeforeMainModule` option was
    // an asbsolute path).
    await Promise.all(
      currentDependencies.map(async module => {
        const name = await module.getName();
        this._modulesByName.set(name, module);
      }),
    );

    // Yet another iteration through all the dependencies. This one is to
    // calculate the inverse dependencies. Right now we cannot do a faster
    // iteration to only calculate this for changed files since
    // `Bundler.getShallowDependencies()` return the relative name of the
    // dependencies (this logic is very similar to the one in
    // getInverseDependencies.js on the react-native repo).
    //
    // TODO: consider moving this calculation directly to
    // `getInverseDependencies()`.
    this._inverseDependencies = new Map();

    currentDependencies.forEach(module => {
      const dependencies = this._dependencyPairs.get(module.path) || [];

      dependencies.forEach(([name, dependencyModule]) => {
        let inverse = this._inverseDependencies.get(dependencyModule.path);

        if (!inverse) {
          inverse = new Set();
          this._inverseDependencies.set(dependencyModule.path, inverse);
        }
        inverse.add(module.path);
      });
    });

    return {
      added,
      deleted,
    };
  }

  async _getShallowDependencies(module: Module): Promise<Set<string>> {
    if (module.isAsset() || module.isJSON()) {
      return new Set();
    }

    const dependencies = await this._bundler.getShallowDependencies({
      ...this._options,
      entryFile: module.path,
      rootEntryFile: this._options.entryFile,
      generateSourceMaps: false,
      transformerOptions: this._transformerOptions || undefined,
    });

    return new Set(dependencies);
  }

  async _getAllDependencies(): Promise<
    ResolutionResponse<Module, BundlingOptions>,
  > {
    return await this._bundler.getDependencies({
      ...this._options,
      rootEntryFile: this._options.entryFile,
      generateSourceMaps: this._options.generateSourceMaps,
      prependPolyfills: false,
    });
  }
}

function areDifferent<T>(first: Set<T>, second: Set<T>): boolean {
  if (first.size !== second.size) {
    return true;
  }

  for (const element of first) {
    if (!second.has(element)) {
      return true;
    }
  }
  return false;
}

module.exports = DeltaCalculator;
