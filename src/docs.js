import { hasTsconfig, fromAegir, fromRoot, readJson, isMonorepoParent } from './utils.js'
import Listr from 'listr'
import fs from 'fs-extra'
import path from 'path'
import { execa } from 'execa'
import { promisify } from 'util'
import ghPages from 'gh-pages'
import { premove as del } from 'premove/sync'
import { fileURLToPath } from 'url'

const publishPages = promisify(ghPages.publish)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * @typedef {import("./types").GlobalOptions} GlobalOptions
 * @typedef {import("./types").DocsOptions} DocsOptions
 * @typedef {import("listr").ListrTaskWrapper} Task
 */

/**
 * Docs command
 *
 * @param {GlobalOptions & DocsOptions} ctx
 * @param {Task} task
 */
const docs = async (ctx, task) => {
  const forwardOptions = ctx['--'] ? ctx['--'] : []

  let entryPoints

  if (isMonorepoParent) {
    entryPoints = await findMonorepoEntryPoints()
  } else {
    entryPoints = await findProjectEntryPoints()
  }

  // run typedoc
  const proc = execa(
    'typedoc',
    [
      ...entryPoints,
      '--out',
      'docs',
      '--hideGenerator',
      '--includeVersion',
      '--gitRevision',
      'master',
      '--plugin',
      fromAegir('src/docs/typedoc-plugin.cjs'),
      '--plugin',
      fromAegir('src/docs/unknown-symbol-resolver-plugin.cjs'),
      '--plugin',
      fromAegir('src/docs/type-indexer-plugin.cjs'),
      '--plugin',
      'typedoc-plugin-mdn-links',
      ...forwardOptions
    ],
    {
      localDir: path.join(__dirname, '..'),
      preferLocal: true,
      all: true
    }
  )
  proc.all?.on('data', (chunk) => {
    task.output = chunk.toString().replace('\n', '')
  })
  await proc

  // write .nojekyll file
  fs.writeFileSync('docs/.nojekyll', '')
}

async function findProjectEntryPoints () {
  const exportsMap = readJson(fromRoot('package.json')).exports

  if (!hasTsconfig) {
    throw new Error('Documentation requires typescript config')
  }

  if (exportsMap == null) {
    throw new Error('Documentation requires exports map')
  }

  const entryPoints = [
    '--tsconfig',
    'tsconfig.json'
  ]

  Object.values(exportsMap).forEach(map => {
    const path = map.import

    if (path == null) {
      return
    }

    if (path.includes('./dist/src')) {
      // transform `./dist/src/index.js` to `./src/index.ts`
      entryPoints.push(`.${path.match(/\.\/dist(\/src\/.*).js/)[1]}.ts`)
    } else {
      entryPoints.push(path)
    }
  })

  return entryPoints
}

async function findMonorepoEntryPoints () {
  /** @type {string[]} */
  return [
    '.',
    '--entryPointStrategy',
    'packages'
  ]
}

/**
 * @typedef {object} PublishDocsConfig
 * @property {string} PublishDocsConfig.user
 * @property {string} PublishDocsConfig.email
 * @property {string} PublishDocsConfig.message
 */

/**
 * @param {PublishDocsConfig} config
 */
const publishDocs = async (config) => {
  // https://github.com/tschaub/gh-pages#deploying-with-github-actions
  await execa('git', ['remote', 'set-url', 'origin', `https://git:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`])

  return publishPages(
    'docs',
    // @ts-ignore - promisify returns wrong type
    {
      dotfiles: true,
      message: config.message,
      user: {
        name: config.user,
        email: config.email
      }
    }
  )
}

const tasks = new Listr(
  [
    {
      title: 'Clean ./docs',
      task: () => {
        del('docs')
      }
    },
    {
      title: 'Generating documentation',
      /**
       *
       * @param {GlobalOptions & DocsOptions} ctx
       * @param {Task} task
       */
      task: docs
    },
    {
      title: 'Publish to GitHub Pages',
      task: (ctx) => publishDocs(ctx),
      enabled: (ctx) => ctx.publish && hasTsconfig
    }
  ],
  {
    renderer: 'verbose'
  }
)

export default tasks
