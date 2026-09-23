import { render } from 'solid-js/web'
import { HashRouter } from '@solidjs/router'
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  type Platform,
} from '@opencode-ai/app'
import { base64Encode } from '@opencode-ai/util/encode'

const VERSION = '1.2.27'
const params = new URLSearchParams(location.search)
const taskID = params.get('task')
const selected = params.get('session')
const root = document.getElementById('root')!

async function boot() {
  if (!taskID) throw new Error('缺少 Task ID')
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(taskID)}/workspace${selected ? `?session_id=${encodeURIComponent(selected)}` : ''}`,
  )
  const binding = await response.json()
  if (!response.ok) throw new Error(binding.detail)
  if (binding.runtime.opencode_version !== VERSION) {
    throw new Error(`Workspace UI ${VERSION} 与 OpenCode ${binding.runtime.opencode_version} 不匹配`)
  }

  const sessionID = selected || binding.runtime.session_id
  if (!sessionID) throw new Error('任务尚未绑定 OpenCode Session')
  if (!binding.sessions.some((session: { id: string }) => session.id === sessionID)) {
    throw new Error('Session 不属于此任务')
  }

  const endpoint = `${location.origin}${binding.runtime.server}/${encodeURIComponent(sessionID)}`
  const server: ServerConnection.Http = { type: 'http', http: { url: endpoint } }
  location.hash = `/${base64Encode(binding.runtime.workspace)}/session/${sessionID}`

  const platform: Platform = {
    platform: 'web',
    version: VERSION,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin)
      if (url.origin === location.origin && ['/global/health', '/api/health'].includes(url.pathname)) {
        return fetch(endpoint + '/global/health', init)
      }
      return fetch(input, init)
    },
    openLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    restart: async () => location.reload(),
    back: () => history.back(),
    forward: () => history.forward(),
    notify: async () => {},
    storage: (name) => ({
      getItem: (key) => localStorage.getItem(`${taskID}:${name}:${key}`),
      setItem: (key, value) => localStorage.setItem(`${taskID}:${name}:${key}`, value),
      removeItem: (key) => localStorage.removeItem(`${taskID}:${name}:${key}`),
    }),
  }

  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(endpoint)}
            servers={[server]}
            router={HashRouter}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}

boot().catch((error) => {
  root.textContent = String(error?.message || error)
})
