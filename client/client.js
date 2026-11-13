// Client half of dsh-monitor: the 「派生监管者」 button in a session's header.
//
// Why a button: `/monitor <sessionId>` requires you to know an id and to type the
// command in a second session. That is two decisions for one intention ("watch
// this one"). The header button turns it into one click.
//
// The derived supervisor is named `监管 · <target title>` so the pair stays
// recognizable in the sidebar, and so the same button can tell that one already
// exists — then it jumps there instead of deriving a second supervisor.
//
// The registration id IS the package name: dsh-client-modules composes one boot
// graph row per active Loader entry's resolved package and only strips a trailing
// `/client` from a registration id, so any other id leaves the row unregistered
// and aborts web boot. The server half is `index.mjs`.

if (typeof window !== 'undefined') window.__ModuleLoader__.load({
  id: 'dsh-monitor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const jsx = require('react/jsx-runtime')

    const NS = 'monitor.derive'

    /** Title prefix that marks a session as the supervisor of another one. */
    const SUPERVISOR_PREFIX = '监管 · '

    const LABELS = {
      zh: {
        label: '派生监管者',
        jump: '跳转到监管者',
        hint: '新开一个监督会话盯住当前会话：命令会填好，回车即开始（每 5 分钟一轮）',
        hintJump: '这个会话已经有监管者了，点一下跳过去',
      },
      en: {
        label: 'Derive supervisor',
        jump: 'Open supervisor',
        hint: 'Open a supervisor session for this one; the command is pre-filled, Enter starts it (one round every 5 minutes)',
        hintJump: 'This session already has a supervisor; click to open it',
      },
    }

    const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

    // Header-band buttons are compact; the stock primitives are not required here
    // so the button keeps working if the primitives bundle changes.
    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '26px',
      padding: '0 10px',
      fontSize: '12px',
      lineHeight: '1',
      color: 'inherit',
      background: 'transparent',
      border: '1px solid currentColor',
      borderRadius: '6px',
      opacity: 0.75,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    /** The name a derived supervisor gets for one target session. */
    function supervisorTitle(sessionId, title) {
      return `${SUPERVISOR_PREFIX}${(title ?? '').trim() === '' ? sessionId : title.trim()}`
    }

    /** The header button: derive a supervisor, or jump to the existing one. */
    function DeriveSupervisorButton({ sessionId, useSessions, derive, focus, t }) {
      const isSupervisor = useSessions((state) => (state.byId[sessionId]?.title ?? '').startsWith(SUPERVISOR_PREFIX))
      const existingId = useSessions((state) => {
        const wanted = supervisorTitle(sessionId, state.byId[sessionId]?.title)
        const found = Object.values(state.byId ?? {}).find((session) => (session.title ?? '') === wanted)
        return found?.id
      })
      // A supervisor has no supervisor of its own: two would just talk past each other.
      if (isSupervisor === true) return null
      const jump = typeof existingId === 'string' && existingId !== ''
      const hint = t(jump ? 'hintJump' : 'hint')
      return jsx.jsx('button', {
        type: 'button',
        title: hint,
        'aria-label': hint,
        style: BUTTON_STYLE,
        onClick: () => (jump ? focus(existingId) : derive(sessionId)),
        children: t(jump ? 'jump' : 'label'),
      })
    }

    /**
     * Register the header action.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, LABELS), 'monitor: dictionaries')
      const t = ctx.locale.bind(NS)

      /** Give the freshly derived session the name that links it to its target. */
      const nameDerived = (previousMainId, targetTitle) => {
        let attempts = 24
        const tick = () => {
          const mainId = ctx.uiWorkspace.mainReference?.sessionId
          if (mainId !== undefined && mainId !== previousMainId) {
            const title = supervisorTitle(mainId, targetTitle)
            try {
              const request = ctx.sessions.using(mainId, { source: 'monitor-derive' }, (reference) => (
                reference.binding.session.rename(title)
              ))
              if (request !== undefined && typeof request.catch === 'function') {
                request.catch((error) => console.warn('[monitor] 监管者改名失败', error))
              }
            } catch (error) {
              console.warn('[monitor] 监管者改名失败', error)
            }
            return
          }
          attempts -= 1
          if (attempts > 0) setTimeout(tick, 150)
        }
        setTimeout(tick, 150)
      }

      const actions = (sessionId) => ({
        t,
        focus: (id) => {
          try {
            ctx.uiWorkspace.openSession(id)
          } catch (error) {
            console.warn('[monitor] 打开监管者失败', error)
          }
        },
        derive: (address) => {
          const target = typeof address === 'string' && address !== '' ? address : sessionId
          if (typeof target !== 'string' || target === '') {
            console.warn('[monitor] derive: 没有拿到会话 id，已放弃', { address, sessionId })
            return
          }
          const title = ctx.uiWorkspace.sessions?.list?.getSnapshot?.()?.byId?.[target]?.title
          const command = `/monitor ${target}`
          try {
            // startSession needs the owning workspace id explicitly; passing none
            // only clears the main view when the session is not the tracked main.
            const workspaces = ctx.uiWorkspace.workspaces.list.getSnapshot()
            const owner = (workspaces.items ?? []).find((item) => (item.sessionIds ?? []).includes(target))
            const before = ctx.uiWorkspace.mainReference?.sessionId
            const request = ctx.uiWorkspace.startSession(owner?.workspaceId, {
              prompt: command,
              whenDraftExists: 'replace',
            })
            if (request !== undefined && typeof request.catch === 'function') {
              request.catch((error) => console.error('[monitor] startSession 失败', error))
            }
            // The command lands in the new session's composer, not in its history:
            // the client API exposes no submit for another session's input, so the
            // click stops at a pre-filled `/monitor <id>` and one Enter starts it.
            nameDerived(before, title)
          } catch (error) {
            console.error('[monitor] startSession 抛错', error)
          }
        },
      })

      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'monitor-derive-supervisor',
        order: 20,
        locale: NS,
        inject: actions,
      }, DeriveSupervisorButton)), 'monitor: header button')
    }

    exports.NS = NS
    exports.SUPERVISOR_PREFIX = SUPERVISOR_PREFIX
    exports.supervisorTitle = supervisorTitle
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
