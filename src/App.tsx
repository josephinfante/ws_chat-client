import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type UserSession = {
  sessionId: string
  username: string
  connectedAt: string
}

type ChatMessage = {
  id: string
  type: 'chat'
  sessionId: string
  username: string
  content: string
  createdAt: string
}

type ServerEvent =
  | {
      type: 'connected'
      payload: {
        session: UserSession
        onlineUsers: UserSession[]
        messageCount: number
      }
    }
  | {
      type: 'history'
      payload: {
        messages: ChatMessage[]
      }
    }
  | {
      type: 'message_created'
      payload: {
        message: ChatMessage
      }
    }
  | {
      type: 'user_joined'
      payload: {
        session: UserSession
        onlineUsers: UserSession[]
      }
    }
  | {
      type: 'user_left'
      payload: {
        sessionId: string
        onlineUsers: UserSession[]
      }
    }
  | {
      type: 'error'
      payload: {
        message: string
      }
    }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
const WS_URL = (import.meta.env.VITE_WS_URL ?? 'ws://localhost:3001/ws').replace(
  /\/$/,
  '',
)
const SESSION_STORAGE_KEY = 'live-chat-session'
const UNKNOWN_SESSION_MESSAGE = 'Unknown session. Create one through GET /session first.'

function App() {
  const [session, setSession] = useState<UserSession | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [onlineUsers, setOnlineUsers] = useState<UserSession[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'booting' | 'connecting' | 'online' | 'offline'>(
    'booting',
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const messagesFeedRef = useRef<HTMLDivElement | null>(null)
  const shouldReconnectRef = useRef(true)
  const needsFreshSessionRef = useRef(false)
  const sessionRef = useRef<UserSession | null>(null)

  const persistSession = (nextSession: UserSession) => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession))
    sessionRef.current = nextSession
    setSession(nextSession)
  }

  const clearSession = () => {
    localStorage.removeItem(SESSION_STORAGE_KEY)
    sessionRef.current = null
    setSession(null)
  }

  const requestSession = useEffectEvent(async () => {
    const response = await fetch(`${API_URL}/session`)

    if (!response.ok) {
      throw new Error(`Session request failed with status ${response.status}`)
    }

    const data = (await response.json()) as { session: UserSession }
    persistSession(data.session)
    return data.session
  })

  const handleServerEvent = useEffectEvent((event: ServerEvent) => {
    switch (event.type) {
      case 'connected':
        setStatus('online')
        setOnlineUsers(event.payload.onlineUsers)
        setErrorMessage(null)
        break
      case 'history':
        setMessages(event.payload.messages)
        break
      case 'message_created':
        setMessages((currentMessages) => {
          const nextMessages = currentMessages.filter(
            (message) => message.id !== event.payload.message.id,
          )

          return [...nextMessages, event.payload.message]
        })
        break
      case 'user_joined':
        setOnlineUsers(event.payload.onlineUsers)
        break
      case 'user_left':
        setOnlineUsers(event.payload.onlineUsers)
        break
      case 'error':
        if (event.payload.message === UNKNOWN_SESSION_MESSAGE) {
          needsFreshSessionRef.current = true
          clearSession()
          setErrorMessage('Session expired on the server. Creating a new one...')
          socketRef.current?.close()
          return
        }

        setErrorMessage(event.payload.message)
        break
    }
  })

  const connectSocket = useEffectEvent(async (activeSession?: UserSession) => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const nextSession = activeSession ?? sessionRef.current ?? (await requestSession())

    const currentSocket = socketRef.current
    if (
      currentSocket &&
      (currentSocket.readyState === WebSocket.OPEN ||
        currentSocket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    setStatus('connecting')
    const url = new URL(WS_URL)
    url.searchParams.set('sessionId', nextSession.sessionId)
    url.searchParams.set('username', nextSession.username)

    const socket = new WebSocket(url.toString())
    socketRef.current = socket

    socket.addEventListener('open', () => {
      setErrorMessage(null)
    })

    socket.addEventListener('message', (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data) as ServerEvent
        handleServerEvent(event)
      } catch {
        setErrorMessage('Received an invalid event from the server.')
      }
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) {
        return
      }

      socketRef.current = null
      setStatus('offline')

      if (!shouldReconnectRef.current) {
        return
      }

      reconnectTimerRef.current = window.setTimeout(() => {
        const reconnectSession = needsFreshSessionRef.current ? undefined : nextSession
        needsFreshSessionRef.current = false
        void connectSocket(reconnectSession)
      }, 1500)
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket) {
        return
      }

      setErrorMessage('WebSocket connection error. Retrying...')
    })
  })

  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      try {
        const storedSession = localStorage.getItem(SESSION_STORAGE_KEY)
        const parsedSession = storedSession
          ? (JSON.parse(storedSession) as UserSession)
          : null
        const activeSession = parsedSession ?? (await requestSession())

        if (cancelled) {
          return
        }

        if (parsedSession) {
          sessionRef.current = parsedSession
          setSession(parsedSession)
        }

        shouldReconnectRef.current = true
        void connectSocket(activeSession)
      } catch (error) {
        if (cancelled) {
          return
        }

        setStatus('offline')
        setErrorMessage(
          error instanceof Error ? error.message : 'Unable to connect to the chat server.',
        )
      }
    }

    void boot()

    return () => {
      cancelled = true
      shouldReconnectRef.current = false

      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
      }

      socketRef.current?.close()
    }
  }, [])

  useEffect(() => {
    const feed = messagesFeedRef.current
    if (!feed) {
      return
    }

    feed.scrollTo({
      top: feed.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages])

  const handleSendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const content = draft.trim()
    const socket = socketRef.current

    if (!content || !socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    socket.send(
      JSON.stringify({
        type: 'chat_message',
        payload: {
          content,
        },
      }),
    )

    setDraft('')
  }

  const initials = session?.username.slice(0, 2).toUpperCase() ?? '--'
  const canSend = status === 'online' && draft.trim().length > 0

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">Public websocket sandbox</p>
        <h1>Live chat client</h1>
        <p className="hero-copy">
          This React app creates a local session, subscribes to the websocket, and
          keeps the room updated in real time without authentication or a database.
        </p>

        <div className="status-strip">
          <span className={`status-pill status-${status}`}>{status}</span>
          <span>{onlineUsers.length} online</span>
          <span>{messages.length} messages cached</span>
        </div>

        {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

        <div className="identity-card">
          <div className="avatar-chip">{initials}</div>
          <div>
            <p className="identity-label">Current public identity</p>
            <strong>{session?.username ?? 'Creating session...'}</strong>
            <p className="identity-meta">
              Session ID: {session?.sessionId ?? 'Waiting for API'}
            </p>
          </div>
        </div>
      </section>

      <section className="chat-grid">
        <aside className="presence-panel">
          <div className="panel-heading">
            <h2>Room activity</h2>
            <p>Connected users tracked by active websocket session.</p>
          </div>

          <div className="presence-list">
            {onlineUsers.length === 0 ? (
              <p className="empty-state">Nobody is connected yet.</p>
            ) : (
              onlineUsers.map((user) => (
                <article
                  className={`presence-item ${
                    user.sessionId === session?.sessionId ? 'is-self' : ''
                  }`}
                  key={user.sessionId}
                >
                  <div>
                    <strong>{user.username}</strong>
                    <p>{user.sessionId === session?.sessionId ? 'You' : 'Guest user'}</p>
                  </div>
                  <time dateTime={user.connectedAt}>
                    {new Date(user.connectedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </article>
              ))
            )}
          </div>
        </aside>

        <section className="conversation-panel">
          <div className="panel-heading">
            <h2>Conversation</h2>
            <p>Messages stay in memory only, so a server restart clears the room.</p>
          </div>

          <div className="messages-feed" ref={messagesFeedRef}>
            {messages.length === 0 ? (
              <div className="empty-state message-empty">
                <p>No messages yet.</p>
                <p>Open another browser tab and start talking.</p>
              </div>
            ) : (
              messages.map((message) => {
                const isSelf = message.sessionId === session?.sessionId

                return (
                  <article
                    className={`message-bubble ${isSelf ? 'is-self' : ''}`}
                    key={message.id}
                  >
                    <header>
                      <strong>{message.username}</strong>
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </header>
                    <p>{message.content}</p>
                  </article>
                )
              })
            )}
          </div>

          <form className="composer" onSubmit={handleSendMessage}>
            <label className="composer-label" htmlFor="message">
              Message
            </label>
            <div className="composer-row">
              <input
                id="message"
                name="message"
                autoComplete="off"
                className="composer-input"
                disabled={status !== 'online'}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  status === 'online'
                    ? 'Type a message for everyone in the room'
                    : 'Waiting for websocket connection'
                }
                value={draft}
              />
              <button className="send-button" disabled={!canSend} type="submit">
                Send
              </button>
            </div>
          </form>
        </section>
      </section>
    </main>
  )
}

export default App
