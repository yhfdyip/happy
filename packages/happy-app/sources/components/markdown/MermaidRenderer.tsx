import * as React from 'react';
import { View, Platform, Text } from 'react-native';
import { WebView } from 'react-native-webview';
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

// Mermaid render component that works on all platforms
export const MermaidRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [dimensions, setDimensions] = React.useState({ width: 0, height: 200 });
    const [svgContent, setSvgContent] = React.useState<string | null>(null);
    const [hasError, setHasError] = React.useState(false);
    const [nativeError, setNativeError] = React.useState<string | null>(null);

    const onLayout = React.useCallback((event: any) => {
        const { width } = event.nativeEvent.layout;
        setDimensions(prev => ({ ...prev, width }));
    }, []);

    React.useEffect(() => {
        if (!isWeb) {
            return;
        }

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
                        theme: 'dark'
                    });
                }

                if (mermaid.render) {
                    const { svg } = await mermaid.render(
                        `mermaid-${Date.now()}`,
                        props.content
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
    }, [isWeb, props.content]);

    React.useEffect(() => {
        if (isWeb) {
            return;
        }

        setNativeError(null);
        setDimensions(prev => ({ ...prev, height: 200 }));
    }, [isWeb, props.content]);

    // Web platform uses direct SVG rendering for better performance and native DOM integration
    if (isWeb) {
        if (hasError) {
            return (
                <View style={[style.container, style.errorContainer]}>
                    <View style={style.errorContent}>
                        <Text style={style.errorText}>Mermaid diagram syntax error</Text>
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
    }

    const source = JSON.stringify(props.content);

    // For iOS/Android, use WebView
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
            <style>
                body {
                    margin: 0;
                    padding: 16px;
                    background-color: ${theme.colors.surfaceHighest};
                    color: ${theme.colors.text};
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                #mermaid-container {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    width: 100%;
                    min-height: 120px;
                }
                .mermaid {
                    text-align: center;
                    width: 100%;
                }
                .mermaid svg {
                    max-width: 100%;
                    height: auto;
                }
                .mermaid-error {
                    white-space: pre-wrap;
                    text-align: left;
                    width: 100%;
                    background-color: ${theme.colors.surfaceHigh};
                    border-radius: 6px;
                    padding: 12px;
                    box-sizing: border-box;
                    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
                }
            </style>
        </head>
        <body>
            <div id="mermaid-container" class="mermaid">
                Loading diagram...
            </div>
            <script>
                const postMessage = (payload) => {
                    if (window.ReactNativeWebView?.postMessage) {
                        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
                    }
                };

                const updateDimensions = () => {
                    const container = document.getElementById('mermaid-container');
                    const containerHeight = container?.getBoundingClientRect?.().height || 0;
                    const bodyHeight = Math.max(
                        document.body?.scrollHeight || 0,
                        document.documentElement?.scrollHeight || 0,
                        containerHeight
                    );
                    postMessage({ type: 'dimensions', height: Math.ceil(bodyHeight + 16) });
                };

                const renderDiagram = async () => {
                    const container = document.getElementById('mermaid-container');
                    const diagramSource = ${source};

                    try {
                        if (!window.mermaid) {
                            throw new Error('Mermaid library not loaded');
                        }

                        mermaid.initialize({
                            startOnLoad: false,
                            theme: 'dark',
                            securityLevel: 'loose'
                        });

                        const { svg } = await mermaid.render('mermaid-' + Date.now(), diagramSource);
                        container.className = 'mermaid';
                        container.innerHTML = svg;
                        updateDimensions();
                    } catch (error) {
                        container.className = 'mermaid-error';
                        container.textContent = diagramSource;
                        updateDimensions();
                        postMessage({
                            type: 'error',
                            message: error && error.message ? error.message : String(error)
                        });
                    }
                };

                window.addEventListener('load', () => {
                    renderDiagram();
                });

                window.addEventListener('resize', updateDimensions);
            </script>
        </body>
        </html>
    `;

    if (nativeError) {
        return (
            <View style={[style.container, style.errorContainer]}>
                <View style={style.errorContent}>
                    <Text style={style.errorText}>Mermaid diagram syntax error</Text>
                    <View style={style.codeBlock}>
                        <Text style={style.codeText}>{props.content}</Text>
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={style.container} onLayout={onLayout}>
            <View style={[style.innerContainer, { height: dimensions.height }]}>
                <WebView
                    source={{ html }}
                    originWhitelist={['*']}
                    style={{ flex: 1 }}
                    javaScriptEnabled
                    domStorageEnabled
                    scrollEnabled={false}
                    onMessage={(event) => {
                        try {
                            const data = JSON.parse(event.nativeEvent.data);

                            if (data.type === 'dimensions' && typeof data.height === 'number' && Number.isFinite(data.height)) {
                                setDimensions(prev => ({
                                    ...prev,
                                    height: Math.max(100, Math.ceil(data.height))
                                }));
                            }

                            if (data.type === 'error') {
                                const message = typeof data.message === 'string' ? data.message : t('markdown.mermaidRenderFailed');
                                console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${message}`);
                                setNativeError(message);
                            }
                        } catch {
                            console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: Invalid WebView message`);
                        }
                    }}
                />
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
}));
