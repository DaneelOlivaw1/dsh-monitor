// Client half of dsh-monitor: the 「派生监管者」 button in a session's header.
//
// Why a button: `/monitor <sessionId>` requires you to know an id and to type the
// command in a second session. That is two decisions for one intention ("watch
// this one"). The header button turns it into one click: it starts a fresh
// session and hands it the command for the session you are looking at.
//
// The registration id IS the package name: dsh-client-modules composes one boot
// graph row per active Loader entry's resolved package and only strips a trailing
// `/client` from a registration id, so any other id leaves the row unregistered
// and aborts web boot. The server half is `index.mjs`; this file is the browser
// half of the same package.

if (typeof window !== 'undefined') window.__ModuleLoader__.load({
  id: 'dsh-monitor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const jsx = require('react/jsx-runtime')

    // The slot's namespace for copy; the labels live next to the button because
    // they describe an action, not a config field.
    const NS = 'monitor.derive'

    const LABELS = {
      zh: {
        label: '派生监管者',
        hint: '新开一个监督会话盯住当前会话：命令会填好，回车即开始（每 5 分钟一轮）',
      },
      en: {
        label: 'Derive supervisor',
        hint: 'Open a supervisor session that watches this one, one round every 5 minutes',
      },
    }

    const inject = ['slots', 'locale', 'uiWorkspace']

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

    /** The header button. `sessionId` comes from the slot's standard props. */
    function DeriveSupervisorButton({ sessionId, derive, t }) {
      const hint = t('hint')
      return jsx.jsx('button', {
        type: 'button',
        title: hint,
        'aria-label': hint,
        style: BUTTON_STYLE,
        onClick: () => derive(sessionId),
        children: t('label'),
      })
    }

    /**
     * Register the header action.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, LABELS), 'monitor: dictionaries')
      const t = ctx.locale.bind(NS)

      // The slot passes the address of the session being viewed, so the derived
      // supervisor always targets the session the button sits on.
      const actions = (sessionId) => ({
        t,
        derive: (address) => {
          const target = typeof address === 'string' && address !== '' ? address : sessionId
          if (typeof target !== 'string' || target === '') {
            console.warn('[monitor] derive: 没有拿到会话 id，已放弃', { address, sessionId })
            return
          }
          const command = `/monitor ${target}`
          try {
            // startSession needs the owning workspace id explicitly; passing none
            // only clears the main view when the session is not the tracked main.
            const workspaces = ctx.uiWorkspace.workspaces.list.getSnapshot()
            const owner = (workspaces.items ?? []).find((item) => (item.sessionIds ?? []).includes(target))
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
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
