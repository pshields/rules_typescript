/**
 * @license
 * Copyright 2017 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as path from 'path';
import * as ts from 'typescript';

/**
 * The configuration block provided by the tsconfig "bazelOptions".
 * Note that all paths here are relative to the rootDir, not absolute nor
 * relative to the location containing the tsconfig file.
 */
export interface BazelOptions {
  /** Name of the bazel workspace where we are building. */
  workspaceName: string;

  /** The full bazel target that is being built, e.g. //my/pkg:library. */
  target: string;

  /** If true, convert require()s into goog.module(). */
  googmodule: boolean;

  /** If true, emit ES5 into filename.es5.js. */
  es5Mode: boolean;

  /** If true, convert TypeScript code into a Closure-compatible variant. */
  tsickle: boolean;

  /** If true, generate externs from declarations in d.ts files. */
  tsickleGenerateExterns: boolean;

  /** Write generated externs to the given path. */
  tsickleExternsPath: string;

  /** Paths of declarations whose types must not appear in result .d.ts. */
  typeBlackListPaths: string[];

  /** If true, emit Closure types in TypeScript->JS output. */
  untyped: boolean;

  /** The list of sources we're interested in (emitting and type checking). */
  compilationTargetSrc: string[];

  /** Path to write the module dependency manifest to. */
  manifest: string;

  /**
   * Whether to disable strict deps check. If true the next parameter is
   * ignored.
   */
  disableStrictDeps?: boolean;

  /**
   * Paths of dependencies that are allowed by strict deps, i.e. that may be
   * imported by the source files in compilationTargetSrc.
   */
  allowedStrictDeps: string[];

  /** Write a performance trace to this path. Disabled when falsy. */
  perfTracePath?: string;

  /**
   * A list of Tsetse rule names that should not run on this target.
   */
  // TODO(calebegg): Remove this and consolidate with plugin disabled rules
  disabledTsetseRules: string[];

  /**
   * An additional prelude to insert after the `goog.module` call,
   * e.g. with additional imports or requires.
   */
  prelude: string;

  /**
   * Name of the current locale if processing a locale-specific file.
   */
  locale?: string;

  /**
   * A list of errors this compilation is expected to generate, in the form
   * "TS1234:regexp". If empty, compilation is expected to succeed.
   */
  expectedDiagnostics: string[];

  /**
   * To support node_module resolution, allow TypeScript to make arbitrary
   * file system access to paths under this prefix.
   */
  nodeModulesPrefix: string;

  /**
   * List of regexes on file paths for which we suppress tsickle's warnings.
   */
  ignoreWarningPaths: string[];

  /**
   * Whether to add aliases to the .d.ts files to add the exports to the
   * ಠ_ಠ.clutz namespace.
   */
  addDtsClutzAliases: true;
}

export interface ParsedTsConfig {
  options: ts.CompilerOptions;
  bazelOpts: BazelOptions;
  files: string[];
  config: {};
}

/**
 * Load a tsconfig.json and convert all referenced paths (including
 * bazelOptions) to absolute paths.
 * Paths seen by TypeScript should be absolute, to match behavior
 * of the tsc ModuleResolution implementation.
 * @param tsconfigFile path to tsconfig, relative to process.cwd() or absolute
 * @return configuration parsed from the file, or error diagnostics
 */
export function parseTsconfig(
    tsconfigFile: string, host: ts.ParseConfigHost = ts.sys):
    [ParsedTsConfig|null, ts.Diagnostic[]|null, {target: string}] {
  // TypeScript expects an absolute path for the tsconfig.json file
  tsconfigFile = path.resolve(tsconfigFile);

  const {config, error} = ts.readConfigFile(tsconfigFile, host.readFile);
  if (error) {
    // target is in the config file we failed to load...
    return [null, [error], {target: ''}];
  }

  const bazelOpts: BazelOptions = config.bazelOptions;
  const target = bazelOpts.target;
  bazelOpts.allowedStrictDeps = bazelOpts.allowedStrictDeps || [];
  bazelOpts.typeBlackListPaths = bazelOpts.typeBlackListPaths || [];
  bazelOpts.compilationTargetSrc = bazelOpts.compilationTargetSrc || [];

  // Allow Bazel users to control some of the bazel options.
  // Since TypeScript's "extends" mechanism applies only to "compilerOptions"
  // we have to repeat some of their logic to get the user's bazelOptions.
  if (config.extends) {
    let userConfigFile =
        path.resolve(path.dirname(tsconfigFile), config.extends);
    if (!userConfigFile.endsWith('.json')) userConfigFile += '.json';
    const {config: userConfig, error} =
        ts.readConfigFile(userConfigFile, host.readFile);
    if (error) {
      return [null, [error], {target}];
    }
    if (userConfig.bazelOptions) {
      bazelOpts.disableStrictDeps = bazelOpts.disableStrictDeps ||
          userConfig.bazelOptions.disableStrictDeps;
    }
  }

  const {options, errors, fileNames} =
      ts.parseJsonConfigFileContent(config, host, path.dirname(tsconfigFile));
  if (errors && errors.length) {
    return [null, errors, {target}];
  }

  // Sort rootDirs with longest include directories first.
  // When canonicalizing paths, we always want to strip
  // `workspace/bazel-bin/file` to just `file`, not to `bazel-bin/file`.
  if (options.rootDirs) options.rootDirs.sort((a, b) => b.length - a.length);

  // TypeScript's parseJsonConfigFileContent returns paths that are joined, eg.
  // /path/to/project/bazel-out/arch/bin/path/to/package/../../../../../../path
  // We normalize them to remove the intermediate parent directories.
  // This improves error messages and also matches logic in tsc_wrapped where we
  // expect normalized paths.
  const files = fileNames.map(f => path.normalize(f));

  // The bazelOpts paths in the tsconfig are relative to
  // options.rootDir (the workspace root) and aren't transformed by
  // parseJsonConfigFileContent (because TypeScript doesn't know
  // about them). Transform them to also be absolute here.
  bazelOpts.compilationTargetSrc =
      bazelOpts.compilationTargetSrc.map(f => path.resolve(options.rootDir, f));
  bazelOpts.allowedStrictDeps =
      bazelOpts.allowedStrictDeps.map(f => path.resolve(options.rootDir, f));
  bazelOpts.typeBlackListPaths =
      bazelOpts.typeBlackListPaths.map(f => path.resolve(options.rootDir, f));
  if (bazelOpts.nodeModulesPrefix) {
    bazelOpts.nodeModulesPrefix =
        path.resolve(options.rootDir, bazelOpts.nodeModulesPrefix);
  }

  return [{options, bazelOpts, files, config}, null, {target}];
}
