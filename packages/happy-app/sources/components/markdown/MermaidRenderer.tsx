import * as React from 'react';
import { View, Platform, Text } from 'react-native';
import WebView from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

// Style for Web platform
const webStyle: any = {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 16,
    overflow: 'auto',
};

type MermaidRendererProps = {
    content: string;
};

// Mermaid render component that works on all platforms
export const MermaidRenderer = React.memo((props: MermaidRendererProps) => {
    if (Platform.OS === 'web') {
        return <MermaidRendererWeb content={props.content} />;
    }

    return <MermaidRendererNative content={props.content} />;
});

const MermaidRendererWeb = React.memo((props: MermaidRendererProps) => {
    const [svgContent, setSvgContent] = React.useState<string | null>(null);
    const [hasError, setHasError] = React.useState(false);

    React.useEffect(() => {
        let isMounted = true;
        setHasError(false);
        setSvgContent(null);

        const renderMermaid = async () => {
            try {
                const mermaidModule: any = await import('mermaid');
                const mermaid = mermaidModule.default || mermaidModule;

                if (mermaid.initialize) {
                    mermaid.initialize({
                        startOnLoad: false,
                        theme: 'dark',
                    });
                }

                if (mermaid.render) {
                    const { svg } = await mermaid.render(
                        `mermaid-${Date.now()}`,
                        props.content,
                    );

                    if (isMounted) {
                        setSvgContent(svg);
                    }
                }
            } catch (error) {
                if (isMounted) {
                    console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${error instanceof Error ? error.message : String(error)}`);
                    setHasError(true);
                }
            }
        };

        renderMermaid();

        return () => {
            isMounted = false;
        };
    }, [props.content]);

    if (hasError) {
        return (
            <View style={[style.container, style.errorContainer]}>
                <View style={style.errorContent}>
                    <Text style={style.errorText}>{t('markdown.mermaidRenderFailed')}</Text>
                    <View style={style.codeBlock}>
                        <Text style={style.codeText}>{props.content}</Text>
                    </View>
                </View>
            </View>
        );
    }

    if (!svgContent) {
        return (
            <View style={[style.container, style.loadingContainer]}>
                <View style={style.loadingPlaceholder} />
            </View>
        );
    }

    return (
        <View style={style.container}>
            {/* @ts-ignore - Web only */}
            <div
                style={webStyle}
                dangerouslySetInnerHTML={{ __html: svgContent }}
            />
        </View>
    );
});

const MermaidRendererNative = React.memo((props: MermaidRendererProps) => {
    const { theme } = useUnistyles();
    const [height, setHeight] = React.useState(200);
    const [hasLoaded, setHasLoaded] = React.useState(false);
    const [isReady, setIsReady] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    React.useEffect(() => {
        setHeight(200);
        setHasLoaded(false);
        setIsReady(false);
        setErrorMessage(null);
    }, [props.content]);

    React.useEffect(() => {
        if (isReady || errorMessage) {
            return;
        }

        const timeout = setTimeout(() => {
            setErrorMessage('Mermaid render timeout');
            setIsReady(false);
        }, 7000);

        return () => clearTimeout(timeout);
    }, [isReady, errorMessage, props.content]);

    const html = React.useMemo(() => {
        const safeContent = JSON.stringify(props.content).replace(/<\//g, '<\\/');

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
                <style>
                    body {
                        margin: 0;
                        padding: 16px;
                        background-color: ${theme.colors.surfaceHighest};
                    }
                    #mermaid-container {
                        width: 100%;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                    }
                    #mermaid-container svg {
                        width: 100%;
                        height: auto;
                        max-width: 100%;
                    }
                    .mermaid-fallback {
                        width: 100%;
                        margin: 0;
                        padding: 12px;
                        border-radius: 4px;
                        background-color: rgba(127, 127, 127, 0.12);
                        color: ${theme.colors.text};
                        white-space: pre-wrap;
                        word-break: break-word;
                        box-sizing: border-box;
                        font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
                    }
                </style>
                <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
            </head>
            <body>
                <div id="mermaid-container"></div>
                <script>
                    (function () {
                        const definition = ${safeContent};

                        function showFallback() {
                            const container = document.getElementById('mermaid-container');
                            if (!container) {
                                return;
                            }

                            container.innerHTML = '<pre class="mermaid-fallback"></pre>';
                            const fallback = container.querySelector('.mermaid-fallback');
                            if (fallback) {
                                fallback.textContent = definition;
                            }
                        }

                        function postMessage(payload) {
                            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                                window.ReactNativeWebView.postMessage(JSON.stringify(payload));
                            }
                        }

                        function reportDimensions() {
                            const container = document.getElementById('mermaid-container');
                            const svg = container ? container.querySelector('svg') : null;
                            const svgHeight = svg ? svg.getBoundingClientRect().height : 0;
                            const height = Math.max(
                                120,
                                document.documentElement ? document.documentElement.scrollHeight : 0,
                                document.body ? document.body.scrollHeight : 0,
                                container ? container.scrollHeight : 0,
                                svgHeight + 32
                            );
                            postMessage({ type: 'dimensions', height: Math.ceil(height) });
                        }

                        async function renderMermaid() {
                            try {
                                if (!window.mermaid || typeof window.mermaid.render !== 'function') {
                                    throw new Error('Mermaid script failed to load');
                                }

                                window.mermaid.initialize({
                                    startOnLoad: false,
                                    theme: 'dark',
                                });

                                const result = await window.mermaid.render('mermaid-' + Date.now(), definition);
                                const container = document.getElementById('mermaid-container');
                                if (!container) {
                                    throw new Error('Mermaid container not found');
                                }

                                container.innerHTML = result.svg;
                                reportDimensions();
                                postMessage({ type: 'ready' });
                            } catch (error) {
                                showFallback();
                                reportDimensions();
                                postMessage({
                                    type: 'error',
                                    message: error && error.message ? error.message : String(error),
                                });
                            }
                        }

                        if (document.readyState === 'loading') {
                            document.addEventListener('DOMContentLoaded', renderMermaid);
                        } else {
                            renderMermaid();
                        }

                        window.addEventListener('load', reportDimensions);
                        window.addEventListener('resize', reportDimensions);

                        setTimeout(function () {
                            const container = document.getElementById('mermaid-container');
                            const hasSvg = container && container.querySelector('svg');
                            if (!hasSvg) {
                                showFallback();
                                reportDimensions();
                                postMessage({ type: 'error', message: 'Mermaid render timeout' });
                            }
                        }, 5000);
                    })();
                </script>
            </body>
            </html>
        `;
    }, [props.content, theme.colors.surfaceHighest]);

    const onMessage = React.useCallback((event: any) => {
        let data: any = null;

        try {
            data = JSON.parse(event.nativeEvent.data);
        } catch {
            return;
        }

        if (data?.type === 'dimensions' && typeof data.height === 'number' && Number.isFinite(data.height)) {
            const nextHeight = Math.max(120, Math.min(4096, Math.ceil(data.height)));
            setHeight((prev) => Math.max(prev, nextHeight));
            return;
        }

        if (data?.type === 'ready') {
            setIsReady(true);
            setErrorMessage(null);
            return;
        }

        if (data?.type === 'error') {
            const detail = typeof data.message === 'string' ? data.message : t('markdown.mermaidRenderFailed');
            console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${detail}`);
            setErrorMessage(detail);
            setIsReady(false);
        }
    }, []);

    const onWebViewError = React.useCallback((event: any) => {
        const detail = event?.nativeEvent?.description || t('markdown.mermaidRenderFailed');
        console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${detail}`);
        setErrorMessage(detail);
        setIsReady(false);
    }, []);

    const onWebViewLoadEnd = React.useCallback(() => {
        setHasLoaded(true);
    }, []);

    if (errorMessage) {
        return (
            <View style={[style.container, style.errorContainer]}>
                <View style={style.errorContent}>
                    <Text style={style.errorText}>{t('markdown.mermaidRenderFailed')}</Text>
                    <Text style={style.errorDetailText}>{errorMessage}</Text>
                    <View style={style.codeBlock}>
                        <Text style={style.codeText}>{props.content}</Text>
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={style.container}>
            <View style={[style.innerContainer, { height }]}> 
                <WebView
                    source={{ html }}
                    style={{ flex: 1 }}
                    originWhitelist={['*']}
                    javaScriptEnabled={true}
                    domStorageEnabled={true}
                    setSupportMultipleWindows={false}
                    scrollEnabled={false}
                    onMessage={onMessage}
                    onError={onWebViewError}
                    onHttpError={onWebViewError}
                    onLoadEnd={onWebViewLoadEnd}
                />
                {!isReady && !errorMessage && !hasLoaded && (
                    <View style={style.loadingOverlay} pointerEvents="none">
                        <View style={style.loadingPlaceholder} />
                    </View>
                )}
            </View>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    innerContainer: {
        width: '100%',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        overflow: 'hidden',
    },
    loadingContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        height: 100,
    },
    loadingPlaceholder: {
        width: 200,
        height: 20,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
    },
    errorContainer: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        padding: 16,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 12,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
    },
    errorDetailText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    loadingOverlay: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
}));
