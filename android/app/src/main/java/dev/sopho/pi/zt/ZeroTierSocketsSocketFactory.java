package dev.sopho.pi.zt;

import com.zerotier.sockets.ZeroTierNative;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.SocketException;
import java.util.Locale;
import javax.net.SocketFactory;

/**
 * libzt 的 OkHttp 适配层。
 *
 * 形状照 feishu-dispatcher 的 `client/android/app/src/main/java/.../network/ZeroTierSocketsSocketFactory.java`
 * （那份抄自 libzt-android-examples 的 okhttpclient demo）。本文件是**新写的一份**，只实现 OkHttp 4.12
 * 明文路径真正用到的方法；没实现的方法显式抛 {@link UnsupportedOperationException}，不静默返回假值。
 *
 * 与上一版的关键差别（都来自固定 AAR 的字节码/源码，见 {@link LibztSockets}）：
 * 1. **不再用** `new ZeroTierSocket(host, port)`：它把 `timeout=0` 传给 `zts_connect`，native 会按 30 s
 *    自己重试，OkHttp 的 connectTimeout 被丢掉；而且失败时构造器泄漏已经打开的 native fd。
 * 2. **不再用** `ZeroTierSocket.setSoTimeout(ms)`：AAR 把 ms 同时当秒和微秒，读超时变成小时级。
 * 3. 连接失败/取消一定 close fd 且只 close 一次；连接成功把读超时按正确单位设到 native。
 *
 * 一个 factory 只去一个目的地（这是 libzt 的用法，不是本文件的限制）。目标主机取 factory 自己的
 * 地址，而不是 OkHttp 用系统 DNS 解析出来的 address —— libzt 的寻址归 libzt。
 */
public final class ZeroTierSocketsSocketFactory extends SocketFactory {

    private final String address;
    private final int port;

    public ZeroTierSocketsSocketFactory(String address, int port) {
        this.address = address;
        this.port = port;
    }

    @Override
    public Socket createSocket() {
        return new Proxy(address, port);
    }

    @Override
    public Socket createSocket(String host, int port) {
        return new Proxy(host, port);
    }

    @Override
    public Socket createSocket(String host, int port, InetAddress localHost, int localPort) {
        return new Proxy(host, port);
    }

    @Override
    public Socket createSocket(InetAddress host, int port) {
        return new Proxy(host.getHostAddress(), port);
    }

    @Override
    public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) {
        return new Proxy(address.getHostAddress(), port);
    }

    static final class Proxy extends Socket {
        private final String defaultAddress;
        private final int defaultPort;

        /** 连接进行中的 attempt：`close()` 可以从另一个线程关掉它正在用的 fd。 */
        private LibztConnectAttempt attempt;
        /** 连接成功后的原生 fd/streams。 */
        private LibztConnection conn;
        private int soTimeoutMs;
        private boolean closed;
        private boolean connected;

        Proxy(String defaultAddress, int defaultPort) {
            this.defaultAddress = defaultAddress;
            this.defaultPort = defaultPort;
        }

        @Override
        public void connect(SocketAddress endpoint, int timeout) throws IOException {
            int targetPort = defaultPort;
            if (endpoint instanceof InetSocketAddress) {
                int endpointPort = ((InetSocketAddress) endpoint).getPort();
                if (endpointPort > 0) targetPort = endpointPort;
            }

            LibztConnectAttempt local;
            synchronized (this) {
                if (closed) throw new SocketException("libzt socket 已关闭：" + this);
                if (connected && conn != null && !conn.isClosed()) {
                    throw new SocketException("libzt socket 已经连接过：" + this);
                }
                local = LibztSockets.INSTANCE.begin(defaultAddress, targetPort, timeout);
                attempt = local;
            }

            LibztConnection opened;
            try {
                opened = local.connect();
            } catch (IOException | RuntimeException error) {
                synchronized (this) {
                    if (attempt == local) attempt = null;
                }
                throw error;
            }

            synchronized (this) {
                attempt = null;
                if (closed) {
                    // close() 在 connect 返回之后、登记之前发生：fd 接过来以后只关这一次。
                    opened.close();
                    throw new IOException("libzt socket 在连接完成前被关闭：" + this);
                }
                if (soTimeoutMs > 0) {
                    try {
                        // 用 LibztConnection 的正确单位实现；AAR 的 setSoTimeout(ms) 会把 ms 当秒+微秒。
                        opened.setReadTimeout(soTimeoutMs);
                    } catch (SocketException error) {
                        opened.close();
                        throw error;
                    }
                }
                conn = opened;
                connected = true;
            }
        }

        @Override
        public void connect(SocketAddress endpoint) throws IOException {
            connect(endpoint, 0);
        }

        @Override
        public void setSoTimeout(int timeout) throws SocketException {
            if (timeout < 0) throw new IllegalArgumentException("SO_TIMEOUT < 0");
            synchronized (this) {
                soTimeoutMs = timeout;
                if (conn != null && !conn.isClosed()) {
                    conn.setReadTimeout(timeout);
                }
            }
        }

        @Override
        public synchronized int getSoTimeout() {
            if (conn != null && !conn.isClosed()) return conn.getReadTimeoutMs();
            return soTimeoutMs;
        }

        @Override
        public InputStream getInputStream() throws IOException {
            LibztConnection current;
            synchronized (this) {
                current = conn;
            }
            if (current == null) throw new IOException("libzt socket 尚未连接");
            if (current.isClosed()) throw new IOException("libzt socket 已关闭");
            return current.getInput();
        }

        @Override
        public OutputStream getOutputStream() throws IOException {
            LibztConnection current;
            synchronized (this) {
                current = conn;
            }
            if (current == null) throw new IOException("libzt socket 尚未连接");
            if (current.isClosed()) throw new IOException("libzt socket 已关闭");
            return current.getOutput();
        }

        @Override
        public void close() {
            LibztConnectAttempt pending;
            LibztConnection current;
            synchronized (this) {
                if (closed) return;
                closed = true;
                connected = false;
                pending = attempt;
                attempt = null;
                current = conn;
                conn = null;
            }
            // 正在 connect：只置取消标记，由 connect 线程在 native 返回后 close（不跨线程 close 阻塞 fd）。
            // 已连上：请求关闭；若有阻塞 read/write，等它返回（最多 readTimeout）再 close。
            if (pending != null) pending.cancel();
            if (current != null) current.requestClose();
        }

        @Override
        public synchronized boolean isClosed() {
            return closed || (conn != null && conn.isClosed());
        }

        @Override
        public synchronized boolean isConnected() {
            return connected && conn != null && !conn.isClosed();
        }

        @Override
        public void shutdownInput() throws IOException {
            LibztConnection current;
            synchronized (this) {
                current = conn;
            }
            if (current == null) throw new IOException("libzt socket 尚未连接");
            current.shutdownInput();
        }

        @Override
        public void shutdownOutput() throws IOException {
            LibztConnection current;
            synchronized (this) {
                current = conn;
            }
            if (current == null) throw new IOException("libzt socket 尚未连接");
            current.shutdownOutput();
        }

        @Override
        public synchronized boolean isInputShutdown() {
            return conn != null && conn.isInputShutdown();
        }

        @Override
        public synchronized boolean isOutputShutdown() {
            return conn != null && conn.isOutputShutdown();
        }

        @Override
        public void setTcpNoDelay(boolean on) throws SocketException {
            LibztConnection current;
            synchronized (this) {
                current = conn;
            }
            if (current == null) return;
            int rc = ZeroTierNative.zts_set_no_delay(current.getFd(), on ? 1 : 0);
            if (rc != 0) {
                throw new SocketException("libzt zts_set_no_delay 返回 " + rc);
            }
        }

        @Override
        public InetAddress getInetAddress() {
            LibztConnection current;
            synchronized (this) {
                current = conn;
            }
            if (current == null) return null;
            try {
                return InetAddress.getByName(current.getHost());
            } catch (Exception ignored) {
                return null;
            }
        }

        @Override
        public synchronized int getPort() {
            return conn == null ? 0 : conn.getPort();
        }

        @Override
        public synchronized boolean isBound() {
            return conn != null;
        }

        @Override
        public String toString() {
            return String.format(Locale.ROOT, "ZeroTierSocketProxy(%s:%d)", defaultAddress, defaultPort);
        }
    }
}
