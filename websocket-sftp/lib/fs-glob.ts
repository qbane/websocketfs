import { EventEmitter, IEventEmitter } from "./compat";
import { IFilesystem, IItem } from "./fs-api";
import { FileUtil, Path } from "./fs-misc";

interface IItemExt extends IItem {
  relativePath: string;
}

interface IDirInfo {
  path: Path;
  pattern: number;
  depth: number;
}

export interface ISearchOptions {
  nodir?: boolean; // don't match directories
  onlydir?: boolean; // only match directories
  nowildcard?: boolean; // do not allow wildcards
  noglobstar?: boolean; // do not perform globstar matching (treat "**" just like normal "*")
  noexpand?: boolean; // do not automatically append "*" to slash-ended paths
  depth?: number; // maximum globmask matching depth (0 means infinite depth)
  nosort?: boolean; // don't sort the results
  dotdirs?: boolean; // include "." and ".." entries in the results
  all?: boolean; // include all item types in the result
}

export interface ISearchOptionsExt extends ISearchOptions {
  onedir?: boolean; // only list a single directory (wildcards only allowed in the last path segment)
  oneitem?: boolean; // only match a single item (implies nowildcard)
}

class DummyEmitter extends EventEmitter implements IEventEmitter {
  emit() { return false }
}

export function search(
  fs: IFilesystem,
  path: string,
  emitter: IEventEmitter | undefined,
  options: ISearchOptionsExt | undefined,
  callback: (err: Error | null, items?: IItem[]) => void,
): void {
  if (path.length == 0) {
    throw new Error("Empty path");
  }

  // use dummy emitter if not specified
  if (!emitter)
    emitter = new DummyEmitter()

  // prepare options
  options = options ?? {};
  const matchFiles = !(options.onlydir || false);
  const matchDirectories = !(options.nodir || false);
  const ignoreGlobstars = options.noglobstar || false;
  const maxDepth = options.depth ?? 0;
  const matchDotDirs = options.dotdirs || false;
  let expectDir = options.onedir || false;
  const expandDir = !(options.noexpand || false);
  const all = options.all || false;

  // sanity checks
  if (!matchFiles && !matchDirectories)
    throw new Error("Not matching anything with the specified options");

  // on windows, normalize backslashes
  const windows = (<any>fs).isWindows == true;
  path = new Path(path).normalize().path;

  // resulting item list
  const results = <IItemExt[]>[];

  // important variables
  let basePath: Path;
  let glob: RegExp;
  const queue = <IDirInfo[]>[];
  const patterns = <(RegExp | null)[]>[];

  if (path == "/") {
    if (expandDir) return start("", "*");
    expectDir = true;
  } else if (path[path.length - 1] == "/") {
    // append a wildcard to slash-ended paths, or make sure they refer to a directory
    if (expandDir) {
      path += "*";
    } else {
      path = path.substr(0, path.length - 1);
      expectDir = true;
    }
  }

  // search for the first wildcard
  const w1 = path.indexOf("*");
  const w2 = path.indexOf("?");
  let w = w1 < 0 ? w2 : w2 < 0 ? w1 : w2;

  if (w >= 0) {
    // wildcard present -> split the path into base path and mask

    if (options.nowildcard || options.oneitem)
      throw new Error("Wildcards not allowed");

    if (options.onedir) {
      const s = path.indexOf("/", w);
      if (s > w)
        throw new Error("Wildcards only allowed in the last path segment");
    }

    w = path.lastIndexOf("/", w);
    const mask = path.substr(w + 1);
    if (w >= 0) {
      path = path.substr(0, w);
    } else {
      path = ".";
    }

    // start matching
    start(path, mask);
  } else {
    // no wildcards -> determine whether this is a file or directory
    fs.stat(path, (err, stats) => {
      if (err) {
        return callback(err);
      }
      if (stats == null) {
        throw Error("bug");
      }
      try {
        if (!options?.oneitem) {
          if (FileUtil.isDirectory(stats)) {
            // if it's a directory, start matching
            if (expandDir) return start(path, "*");
          } else {
            if (expectDir)
              return callback(
                new Error("The specified path is not a directory"),
              );

            if (!all && !FileUtil.isFile(stats)) {
              // if it's not a file, we are done
              return callback(null, results);
            }

            // otherwise, proceed to adding the item to the results and finishing
          }
        }

        // determine item name
        w = path.lastIndexOf("/");
        let name;
        if (w < 0) {
          name = path;
          path = "./" + name;
        } else {
          name = path.substr(w + 1);
        }

        // push item to the results
        const item = {
          filename: name,
          stats: stats,
          path: path,
          relativePath: name,
        };
        results.push(item);
        emitter?.emit("item", item);
        return callback(null, results);
      } catch (err) {
        return callback(err);
      }
    });
  }

  return;

  // prepare and start the matching
  function start(path: string, mask: string): void {
    // construct base path
    if (path.length == 0 || (windows && path.length == 2 && path[1] == ":"))
      path += "/";
    basePath = new Path(path, fs).normalize();

    mask = "/" + mask;

    let globmask: null | string = null;
    if (!ignoreGlobstars) {
      // determine glob mask (if any)
      const gs = mask.indexOf("/**");
      if (gs >= 0) {
        if (gs == mask.length - 3) {
          globmask = "*";
          mask = mask.substr(0, gs);
        } else if (mask[gs + 3] == "/") {
          globmask = mask.substr(gs + 4);
          mask = mask.substr(0, gs);
        }
      }
    }

    const masks = mask.split("/");

    for (let i = 1; i < masks.length; i++) {
      const mask = masks[i];
      const regex = toRegExp(mask, false);
      patterns.push(regex);
    }

    if (globmask != null) {
      patterns.push(null);
      glob = toRegExp(globmask, true);
    }

    // add path to queue and process it
    queue.push({ path: new Path(""), pattern: 0, depth: 0 });
    next(null);
  }

  // process next directory in the queue
  function next(err: Error | null) {
    if (err) return callback(err);

    // get next directory to traverse
    const current = queue.shift();

    // if no more to process, we are done
    if (!current) {
      // sort the results if requested
      if (!options?.nosort) {
        results.sort((a, b) => {
          if (a.relativePath < b.relativePath) return -1;
          if (a.relativePath > b.relativePath) return 1;
          return 0;
        });
      }

      return callback(null, results);
    }

    let relativePath: Path;
    let index: number;
    let regex: RegExp | null;
    let depth: number;

    let nextIndex;
    let matchItems;
    let enterDirs;

    try {
      // prepare vars
      relativePath = current.path;
      index = current.pattern;
      depth = current.depth;
      regex = patterns[index];

      if (regex) {
        //console.log("Matching (r): ", basePath, path, regex.source);
        nextIndex = index + 1;
        const isLast = nextIndex == patterns.length;
        matchItems = isLast && glob == null;
        enterDirs = !isLast;
      } else {
        // globmask matching

        //console.log("Matching (g): ", basePath, path, glob.source);
        nextIndex = index;
        matchItems = true;
        enterDirs = maxDepth == 0 || (maxDepth > 0 && depth < maxDepth);

        // increment depth for each globmask
        depth++;
      }

      // prepare full path
      const fullPath = basePath.join(relativePath).normalize().path;

      // list items and proceed to directory
      FileUtil.listPath(fs, fullPath, emitter, process, next);
    } catch (err) {
      return callback(err);
    }

    // process a single item
    function process(item: IItemExt): void {
      const isDir = FileUtil.isDirectory(item.stats);
      const isFile = FileUtil.isFile(item.stats);

      const isDotDir = item.filename == "." || item.filename == "..";
      if (isDotDir && !matchDotDirs) return;

      if (!all && !isDir && !isFile) return;

      const itemPath = relativePath.join(item.filename);

      // add subdirectory to queue if desired
      if (enterDirs && isDir && !isDotDir) {
        queue.push({ path: itemPath, pattern: nextIndex, depth: depth });
      }

      // if not matching items in this directory, we are done with it
      if (!matchItems) return;

      // reject items we don't want
      if (isDir && !matchDirectories) return;
      if (isFile && !matchFiles) return;

      if (regex) {
        // mask matching
        if (!regex.test(item.filename)) return;
      } else {
        // globstar matching
        if (!glob.test(itemPath.path)) return;
      }

      // add matched file to the list
      const relative = new Path(itemPath.path, fs).normalize();
      item.path = basePath.join(relative).path;
      item.relativePath = relative.path;
      results.push(item);
      emitter?.emit("item", item);
    }
  }

  // convert mask pattern to regular expression
  function toRegExp(mask: string, globstar: boolean): RegExp {
    let pattern = "^";
    if (globstar) pattern += ".*";
    for (let i = 0; i < mask.length; i++) {
      const c = mask[i];
      switch (c) {
        case "/": {
          const gm = mask.substr(i, 4);
          if (gm == "/**/" || gm == "/**") {
            pattern += ".*";
            i += 3;
          } else {
            pattern += "/";
          }
          break;
        }
        case "*":
          if (globstar) {
            pattern += "[^/]*";
          } else {
            pattern += ".*";
          }
          break;
        case "?":
          pattern += ".";
          break;
        default:
          if (
            (c >= "a" && c <= "z") ||
            (c >= "A" && c <= "Z") ||
            (c >= "0" && c <= "9")
          ) {
            pattern += c;
          } else {
            pattern += "\\" + c;
          }
          break;
      }
    }
    pattern += "$";

    // case insensitive on Windows
    const flags = windows ? "i" : "";

    return new RegExp(pattern, flags);
  }
}
