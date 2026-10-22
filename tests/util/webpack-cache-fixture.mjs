import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import webpack from 'webpack';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Create an isolated project using the application's actual Webpack config. */
export async function createWebpackCacheFixture(configSource, { realLibraries = false } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-webpack-cache-'));
    try {
        await fs.mkdir(path.join(root, 'src'));
        await fs.mkdir(path.join(root, 'public'));
        await fs.symlink(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'junction');
        await fs.writeFile(path.join(root, 'webpack.config.js'), configSource);
        await fs.writeFile(path.join(root, 'src/server-directory.js'), `export const serverDirectory = ${JSON.stringify(root)};\n`);
        await fs.writeFile(path.join(root, 'src/util.js'), `
            import fs from 'node:fs';
            export const color = { yellow: x => x, red: x => x };
            export async function getVersion() {
                return { pkgVersion: '1.0.0', gitRevision: fs.readFileSync(new URL('../revision', import.meta.url), 'utf8') };
            }
        `);
        await fs.writeFile(path.join(root, 'revision'), 'first-commit');
        if (realLibraries) {
            for (const name of ['package.json', 'package-lock.json', 'public/lib.js']) {
                await fs.copyFile(path.join(repositoryRoot, name), path.join(root, name));
            }
        } else {
            await fs.writeFile(path.join(root, 'package.json'), '{"name":"webpack-cache-fixture","version":"1.0.0","type":"module"}\n');
            await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
            await fs.writeFile(path.join(root, 'public/lib.js'), 'export { value } from "./dependency.js";\n');
            await fs.writeFile(path.join(root, 'public/dependency.js'), 'export const value = "initial dependency";\n');
        }
        let generation = 0;
        return {
            root,
            async config(options = {}) {
                const url = pathToFileURL(path.join(root, 'webpack.config.js'));
                url.searchParams.set('generation', String(generation++));
                const { default: getConfig } = await import(url.href);
                const previousCwd = process.cwd();
                try {
                    process.chdir(root);
                    const config = getConfig({ forceDist: true, ...options });
                    config.context ??= root;
                    return config;
                } finally {
                    process.chdir(previousCwd);
                }
            },
            async write(file, content) {
                await fs.writeFile(path.join(root, file), content);
            },
            async cleanup() {
                await fs.rm(root, { recursive: true, force: true });
            },
        };
    } catch (error) {
        await fs.rm(root, { recursive: true, force: true });
        throw error;
    }
}

/** Run and close the real compiler, including persisting its filesystem cache. */
export async function compileWebpackFixture(config) {
    const start = performance.now();
    const compiler = webpack(config);
    const stats = await new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            compiler.close(closeError => {
                if (error || closeError) return reject(error || closeError);
                if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
                resolve(stats);
            });
        });
    });
    const modules = stats.toJson({ all: false, modules: true, cachedModules: true }).modules;
    const output = await fs.readFile(path.join(config.output.path, config.output.filename), 'utf8');
    return { elapsedMs: performance.now() - start, builtModules: modules.filter(module => module.built).length, output };
}
