import { AgentContentView } from '@/components/AgentContentView';
import { AgentInput } from '@/components/AgentInput';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { ChatHeaderView } from '@/components/ChatHeaderView';
import { ChatList } from '@/components/ChatList';
import { Deferred } from '@/components/Deferred';
import { EmptyMessages } from '@/components/EmptyMessages';
import { VoiceAssistantStatusBar } from '@/components/VoiceAssistantStatusBar';
import { useDraft } from '@/hooks/useDraft';
import { Modal } from '@/modal';
import { log } from '@/log';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { startRealtimeSession, stopRealtimeSession } from '@/realtime/RealtimeSession';
import { gitStatusSync } from '@/sync/gitStatusSync';
import { sessionAbort } from '@/sync/ops';
import { storage, useIsDataReady, useLocalSetting, useRealtimeStatus, useSessionMessages, useSessionUsage, useSetting } from '@/sync/storage';
import { useSession } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { DynamicModelOption, fetchCodexModelsForSession } from '@/sync/dynamicModels';
import { t } from '@/text';
import { tracking, trackMessageSent } from '@/track';
import { isRunningOnMac } from '@/utils/platform';
import { useDeviceType, useHeaderHeight, useIsLandscape, useIsTablet } from '@/utils/responsive';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, useSessionStatus } from '@/utils/sessionUtils';
import { isVersionSupported, MINIMUM_CLI_VERSION } from '@/utils/versionUtils';
import type { MessageAttachment } from '@/sync/typesMessageMeta';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

type PendingImage = {
    id: string;
    uri: string;
    width?: number;
    height?: number;
};

type ImageUploadStage = 'prepare' | 'compress' | 'upload' | 'sending';

type ImageUploadProgress = {
    stage: ImageUploadStage;
    current: number;
    total: number;
};

export const SessionView = React.memo((props: { id: string }) => {
    const sessionId = props.id;
    const router = useRouter();
    const session = useSession(sessionId);
    const isDataReady = useIsDataReady();
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const headerHeight = useHeaderHeight();
    const realtimeStatus = useRealtimeStatus();
    const isTablet = useIsTablet();

    // Compute header props based on session state
    const headerProps = useMemo(() => {
        if (!isDataReady) {
            // Loading state - show empty header
            return {
                title: '',
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        if (!session) {
            // Deleted state - show deleted message in header
            return {
                title: t('errors.sessionDeleted'),
                subtitle: undefined,
                avatarId: undefined,
                onAvatarPress: undefined,
                isConnected: false,
                flavor: null
            };
        }

        // Normal state - show session info
        const isConnected = session.presence === 'online';
        return {
            title: getSessionName(session),
            subtitle: session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined,
            avatarId: getSessionAvatarId(session),
            onAvatarPress: () => router.push(`/session/${sessionId}/info`),
            isConnected: isConnected,
            flavor: session.metadata?.flavor || null,
            tintColor: isConnected ? '#000' : '#8E8E93'
        };
    }, [session, isDataReady, sessionId, router]);

    return (
        <>
            {/* Status bar shadow for landscape mode */}
            {isLandscape && deviceType === 'phone' && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: safeArea.top,
                    backgroundColor: theme.colors.surface,
                    zIndex: 1000,
                    shadowColor: theme.colors.shadow.color,
                    shadowOffset: {
                        width: 0,
                        height: 2,
                    },
                    shadowOpacity: theme.colors.shadow.opacity,
                    shadowRadius: 3,
                    elevation: 5,
                }} />
            )}

            {/* Header - always shown on desktop/Mac, hidden in landscape mode only on actual phones */}
            {!(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') && (
                <View style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 1000
                }}>
                    <ChatHeaderView
                        {...headerProps}
                        onBackPress={() => router.back()}
                    />
                    {/* Voice status bar below header - not on tablet (shown in sidebar) */}
                    {!isTablet && realtimeStatus !== 'disconnected' && (
                        <VoiceAssistantStatusBar variant="full" />
                    )}
                </View>
            )}

            {/* Content based on state */}
            <View style={{ flex: 1, paddingTop: !(isLandscape && deviceType === 'phone' && Platform.OS !== 'web') ? safeArea.top + headerHeight + (!isTablet && realtimeStatus !== 'disconnected' ? 48 : 0) : 0 }}>
                {!isDataReady ? (
                    // Loading state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : !session ? (
                    // Deleted state
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <Ionicons name="trash-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={{ color: theme.colors.text, fontSize: 20, marginTop: 16, fontWeight: '600' }}>{t('errors.sessionDeleted')}</Text>
                        <Text style={{ color: theme.colors.textSecondary, fontSize: 15, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 }}>{t('errors.sessionDeletedDescription')}</Text>
                    </View>
                ) : (
                    // Normal session view
                    <SessionViewLoaded key={sessionId} sessionId={sessionId} session={session} />
                )}
            </View>
        </>
    );
});


function SessionViewLoaded({ sessionId, session }: { sessionId: string, session: Session }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const safeArea = useSafeAreaInsets();
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    const [message, setMessage] = React.useState('');
    const realtimeStatus = useRealtimeStatus();
    const { messages, isLoaded } = useSessionMessages(sessionId);
    const acknowledgedCliVersions = useLocalSetting('acknowledgedCliVersions');

    // Check if CLI version is outdated and not already acknowledged
    const cliVersion = session.metadata?.version;
    const machineId = session.metadata?.machineId;
    const isCliOutdated = cliVersion && !isVersionSupported(cliVersion, MINIMUM_CLI_VERSION);
    const isAcknowledged = machineId && acknowledgedCliVersions[machineId] === cliVersion;
    const shouldShowCliWarning = isCliOutdated && !isAcknowledged;
    // Get permission mode from session object, prefer live value from agentState if available
    const permissionMode = session.agentState?.currentPermissionMode || session.permissionMode || 'default';
    // Get model mode from session object - Gemini/Codex sessions use explicit model defaults
    const flavor = session.metadata?.flavor;
    const isGeminiSession = flavor === 'gemini';
    const isCodexSession = flavor === 'codex';
    const modelMode = session.modelMode || (isGeminiSession ? 'gemini-2.5-pro' : 'default');
    const [codexModels, setCodexModels] = React.useState<DynamicModelOption[]>([]);
    const sessionStatus = useSessionStatus(session);
    const sessionUsage = useSessionUsage(sessionId);
    const alwaysShowContextSize = useSetting('alwaysShowContextSize');
    const experiments = useSetting('experiments');
    const [isPickingImage, setIsPickingImage] = React.useState(false);
    const [pendingImages, setPendingImages] = React.useState<PendingImage[]>([]);
    const [isSendingMessage, setIsSendingMessage] = React.useState(false);
    const [imageUploadProgress, setImageUploadProgress] = React.useState<ImageUploadProgress | null>(null);
    const isSendingMessageRef = React.useRef(false);

    // Use draft hook for auto-saving message drafts
    const { clearDraft } = useDraft(sessionId, message, setMessage);

    const pickImagesForCodex = React.useCallback(async () => {
        if (!isCodexSession) {
            Modal.alert(t('common.error'), '当前仅 Codex 会话支持从 App 发送图片');
            return;
        }
        if (isPickingImage) {
            return;
        }

        setIsPickingImage(true);
        try {
            if (Platform.OS === 'web') {
                Modal.alert(t('common.error'), 'Web 端暂不支持从相册选择图片上传到 Codex');
                return;
            }

            const pickerResult = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ImagePicker.MediaTypeOptions.Images,
                allowsEditing: false,
                allowsMultipleSelection: true,
                selectionLimit: 10,
                base64: false,
                quality: 1,
                exif: false,
            });
            if (pickerResult.canceled || !pickerResult.assets?.length) {
                return;
            }

            const selectedImages: PendingImage[] = pickerResult.assets.map((asset, index) => ({
                id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
                uri: asset.uri,
                width: asset.width,
                height: asset.height,
            }));

            setPendingImages((prev) => {
                const next = [...prev, ...selectedImages];
                return next.slice(0, 10);
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            Modal.alert(t('common.error'), `发送图片失败：${msg}`);
        } finally {
            setIsPickingImage(false);
        }
    }, [isCodexSession, isPickingImage]);

    const removePendingImage = React.useCallback((imageId: string) => {
        if (isSendingMessage) {
            return;
        }
        setPendingImages((prev) => prev.filter((item) => item.id !== imageId));
    }, [isSendingMessage]);

    const uploadStatusText = React.useMemo(() => {
        if (!isSendingMessage || !imageUploadProgress) {
            return undefined;
        }

        const stageText = imageUploadProgress.stage === 'prepare'
            ? '准备上传图片…'
            : imageUploadProgress.stage === 'compress'
                ? '压缩图片中…'
                : imageUploadProgress.stage === 'upload'
                    ? '上传图片中…'
                    : '发送消息中…';

        return `${stageText} ${imageUploadProgress.current}/${imageUploadProgress.total}`;
    }, [imageUploadProgress, isSendingMessage]);

    const sendPendingImages = React.useCallback(async (text: string) => {
        if (!isCodexSession || pendingImages.length === 0) {
            return false;
        }

        const imageCount = pendingImages.length;
        setImageUploadProgress({ stage: 'prepare', current: 0, total: imageCount });

        const mkdirCommand = `node -e "require('fs').mkdirSync('.happy-attachments',{recursive:true})"`;
        await sync.sessionRpc(sessionId, 'bash', { command: mkdirCommand, cwd: '.', timeout: 15000 });

        const attachments: MessageAttachment[] = [];
        const MAX_RAW_BYTES = 350 * 1024;

        for (let index = 0; index < pendingImages.length; index++) {
            const image = pendingImages[index];
            const progressIndex = index + 1;
            setImageUploadProgress({ stage: 'compress', current: progressIndex, total: imageCount });

            let width = Math.min(image.width ?? 1600, 1600);
            let compress = 0.72;
            let manipulated: ImageManipulator.ImageResult | null = null;

            for (let attempt = 0; attempt < 4; attempt++) {
                manipulated = await ImageManipulator.manipulateAsync(
                    image.uri,
                    width ? [{ resize: { width } }] : [],
                    {
                        compress,
                        format: ImageManipulator.SaveFormat.JPEG,
                        base64: true,
                    }
                );

                const base64 = manipulated.base64 || '';
                const approxBytes = Math.floor((base64.length * 3) / 4);
                if (approxBytes <= MAX_RAW_BYTES && base64.length > 0) {
                    break;
                }

                width = Math.max(720, Math.floor(width * 0.75));
                compress = Math.max(0.45, compress - 0.12);
            }

            if (!manipulated?.base64) {
                throw new Error(`第 ${index + 1} 张图片读取失败`);
            }

            const uploadPath = `.happy-attachments/happy-image-${Date.now()}-${index + 1}.jpg`;
            setImageUploadProgress({ stage: 'upload', current: progressIndex, total: imageCount });

            const writeResult = await sync.sessionRpc(sessionId, 'writeFile', {
                path: uploadPath,
                content: manipulated.base64,
                expectedHash: null
            }) as any;
            if (!writeResult?.success) {
                throw new Error(writeResult?.error || `第 ${index + 1} 张图片写入失败`);
            }

            attachments.push({ type: 'image', path: uploadPath, mimeType: 'image/jpeg' });
        }

        const trimmedText = text.trim();
        const instruction = trimmedText || (imageCount > 1
            ? '请综合分析这些图片并描述其关键信息。'
            : '请分析这张图片并描述其关键信息。');

        const displayText = trimmedText
            ? `📷 已发送 ${imageCount} 张图片\n${trimmedText}`
            : `📷 已发送 ${imageCount} 张图片`;

        setImageUploadProgress({ stage: 'sending', current: imageCount, total: imageCount });

        await sync.sendMessage(
            sessionId,
            instruction,
            displayText,
            attachments
        );
        setPendingImages([]);
        return true;
    }, [isCodexSession, pendingImages, sessionId]);

    // Handle dismissing CLI version warning
    const handleDismissCliWarning = React.useCallback(() => {
        if (machineId && cliVersion) {
            storage.getState().applyLocalSettings({
                acknowledgedCliVersions: {
                    ...acknowledgedCliVersions,
                    [machineId]: cliVersion
                }
            });
        }
    }, [machineId, cliVersion, acknowledgedCliVersions]);

    // Function to update permission mode
    const updatePermissionMode = React.useCallback((mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo') => {
        storage.getState().updateSessionPermissionMode(sessionId, mode);
    }, [sessionId]);

    // Function to update model mode
    const updateModelMode = React.useCallback((mode: string) => {
        storage.getState().updateSessionModelMode(sessionId, mode);
    }, [sessionId]);

    React.useEffect(() => {
        if (!isCodexSession) {
            return;
        }

        let cancelled = false;
        const run = async () => {
            try {
                const models = await fetchCodexModelsForSession(sessionId);
                if (!cancelled) {
                    setCodexModels(models);
                }
            } catch {
                if (!cancelled) {
                    setCodexModels([]);
                }
            }
        };

        void run();

        return () => {
            cancelled = true;
        };
    }, [isCodexSession, sessionId]);

    // Memoize header-dependent styles to prevent re-renders
    const headerDependentStyles = React.useMemo(() => ({
        contentContainer: {
            flex: 1
        },
        flatListStyle: {
            marginTop: 0 // No marginTop needed since header is handled by parent
        },
    }), []);


    // Handle microphone button press - memoized to prevent button flashing
    const handleMicrophonePress = React.useCallback(async () => {
        log.log(`[VoiceTrace] mic_press_entered ${JSON.stringify({ sessionId, realtimeStatus })}`);
        tracking?.capture('voice_mic_press_handler_entered', {
            sessionId,
            realtimeStatus,
        });

        if (realtimeStatus === 'connecting') {
            log.log(`[VoiceTrace] mic_press_ignored ${JSON.stringify({ sessionId, reason: 'connecting' })}`);
            tracking?.capture('voice_mic_press_ignored', {
                sessionId,
                reason: 'connecting',
            });
            return;
        }

        if (realtimeStatus === 'disconnected' || realtimeStatus === 'error') {
            try {
                log.log(`[VoiceTrace] start_attempt ${JSON.stringify({ sessionId, realtimeStatus })}`);
                tracking?.capture('voice_mic_start_attempt', {
                    sessionId,
                    realtimeStatus,
                });

                const initialPrompt = voiceHooks.onVoiceStarted(sessionId);
                await startRealtimeSession(sessionId, initialPrompt);
                log.log(`[VoiceTrace] start_finished ${JSON.stringify({ sessionId })}`);
                tracking?.capture('voice_session_started', { sessionId });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                log.log(`[VoiceTrace] start_error ${JSON.stringify({ sessionId, error: errorMessage })}`);
                console.error('Failed to start realtime session:', error);
                Modal.alert(t('common.error'), t('errors.voiceSessionFailed'));
                tracking?.capture('voice_session_error', { error: errorMessage });
            }
            return;
        }

        if (realtimeStatus === 'connected') {
            log.log(`[VoiceTrace] stop_attempt ${JSON.stringify({ sessionId })}`);
            tracking?.capture('voice_mic_stop_attempt', {
                sessionId,
            });

            await stopRealtimeSession();
            log.log(`[VoiceTrace] stop_finished ${JSON.stringify({ sessionId })}`);
            tracking?.capture('voice_session_stopped');

            // Notify voice assistant about voice session stop
            voiceHooks.onVoiceStopped();
        }
    }, [realtimeStatus, sessionId]);

    // Memoize mic button state to prevent flashing during chat transitions
    const micButtonState = useMemo(() => ({
        onMicPress: handleMicrophonePress,
        isMicActive: realtimeStatus === 'connected' || realtimeStatus === 'connecting'
    }), [handleMicrophonePress, realtimeStatus]);

    // Trigger session visibility and initialize git status sync
    React.useLayoutEffect(() => {

        // Trigger session sync
        sync.onSessionVisible(sessionId);


        // Initialize git status sync for this session
        gitStatusSync.getSync(sessionId);
    }, [sessionId, realtimeStatus]);

    let content = (
        <>
            <Deferred>
                {messages.length > 0 && (
                    <ChatList session={session} />
                )}
            </Deferred>
        </>
    );
    const placeholder = messages.length === 0 ? (
        <>
            {isLoaded ? (
                <EmptyMessages session={session} />
            ) : (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            )}
        </>
    ) : null;

    const input = (
            <AgentInput
                placeholder={t('session.inputPlaceholder')}
                value={message}
                onChangeText={setMessage}
                sessionId={sessionId}
                onPickImage={pickImagesForCodex}
                isPickingImage={isPickingImage}
                pendingImageCount={pendingImages.length}
                pendingImages={pendingImages.map((item) => ({ id: item.id, uri: item.uri }))}
                onRemovePendingImage={removePendingImage}
                isSending={isSendingMessage}
                uploadStatusText={uploadStatusText}
                permissionMode={permissionMode}
                onPermissionModeChange={updatePermissionMode}
                modelMode={modelMode as any}
                onModelModeChange={updateModelMode as any}
                codexModelOptions={codexModels}
            metadata={session.metadata}
            connectionStatus={{
                text: sessionStatus.statusText,
                color: sessionStatus.statusColor,
                dotColor: sessionStatus.statusDotColor,
                isPulsing: sessionStatus.isPulsing
            }}
            onSend={() => {
                if (isSendingMessageRef.current) {
                    return;
                }

                const run = async () => {
                    isSendingMessageRef.current = true;
                    setIsSendingMessage(true);

                    try {
                        if (pendingImages.length > 0) {
                            const textToSend = message;
                            setMessage('');
                            clearDraft();
                            await sendPendingImages(textToSend);
                            trackMessageSent();
                            return;
                        }

                        const trimmedMessage = message.trim();
                        if (!trimmedMessage) {
                            return;
                        }

                        const lowerCommand = trimmedMessage.toLowerCase();
                        if (isCodexSession && lowerCommand === '/plan') {
                            storage.getState().updateSessionPermissionMode(sessionId, 'plan');
                            setMessage('');
                            clearDraft();
                            return;
                        }

                        setMessage('');
                        clearDraft();
                        await sync.sendMessage(sessionId, message);
                        trackMessageSent();
                    } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        Modal.alert(t('common.error'), `发送图片失败：${msg}`);
                    } finally {
                        isSendingMessageRef.current = false;
                        setIsSendingMessage(false);
                        setImageUploadProgress(null);
                    }
                };

                void run();
            }}
            onMicPress={micButtonState.onMicPress}
            isMicActive={micButtonState.isMicActive}
            onAbort={() => sessionAbort(sessionId)}
            showAbortButton={sessionStatus.state === 'thinking' || sessionStatus.state === 'waiting'}
            onFileViewerPress={experiments ? () => router.push(`/session/${sessionId}/files`) : undefined}
            // Autocomplete configuration
            autocompletePrefixes={['@', '/']}
            autocompleteSuggestions={(query) => getSuggestions(sessionId, query)}
            usageData={sessionUsage ? {
                inputTokens: sessionUsage.inputTokens,
                outputTokens: sessionUsage.outputTokens,
                cacheCreation: sessionUsage.cacheCreation,
                cacheRead: sessionUsage.cacheRead,
                contextSize: sessionUsage.contextSize
            } : session.latestUsage ? {
                inputTokens: session.latestUsage.inputTokens,
                outputTokens: session.latestUsage.outputTokens,
                cacheCreation: session.latestUsage.cacheCreation,
                cacheRead: session.latestUsage.cacheRead,
                contextSize: session.latestUsage.contextSize
            } : undefined}
            alwaysShowContextSize={alwaysShowContextSize}
        />
    );


    return (
        <>
            {/* CLI Version Warning Overlay - Subtle centered pill */}
            {shouldShowCliWarning && !(isLandscape && deviceType === 'phone') && (
                <Pressable
                    onPress={handleDismissCliWarning}
                    style={{
                        position: 'absolute',
                        top: 8, // Position at top of content area (padding handled by parent)
                        alignSelf: 'center',
                        backgroundColor: '#FFF3CD',
                        borderRadius: 100, // Fully rounded pill
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        flexDirection: 'row',
                        alignItems: 'center',
                        zIndex: 998, // Below voice bar but above content
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.15,
                        shadowRadius: 4,
                        elevation: 4,
                    }}
                >
                    <Ionicons name="warning-outline" size={14} color="#FF9500" style={{ marginRight: 6 }} />
                    <Text style={{
                        fontSize: 12,
                        color: '#856404',
                        fontWeight: '600'
                    }}>
                        {t('sessionInfo.cliVersionOutdated')}
                    </Text>
                    <Ionicons name="close" size={14} color="#856404" style={{ marginLeft: 8 }} />
                </Pressable>
            )}

            {/* Main content area - no padding since header is overlay */}
            <View style={{ flexBasis: 0, flexGrow: 1, paddingBottom: safeArea.bottom + ((isRunningOnMac() || Platform.OS === 'web') ? 32 : 0) }}>
                <AgentContentView
                    content={content}
                    input={input}
                    placeholder={placeholder}
                />
            </View >

            {/* Back button for landscape phone mode when header is hidden */}
            {
                isLandscape && deviceType === 'phone' && (
                    <Pressable
                        onPress={() => router.back()}
                        style={{
                            position: 'absolute',
                            top: safeArea.top + 8,
                            left: 16,
                            width: 44,
                            height: 44,
                            borderRadius: 22,
                            backgroundColor: `rgba(${theme.dark ? '28, 23, 28' : '255, 255, 255'}, 0.9)`,
                            alignItems: 'center',
                            justifyContent: 'center',
                            ...Platform.select({
                                ios: {
                                    shadowColor: '#000',
                                    shadowOffset: { width: 0, height: 2 },
                                    shadowOpacity: 0.1,
                                    shadowRadius: 4,
                                },
                                android: {
                                    elevation: 2,
                                }
                            }),
                        }}
                        hitSlop={15}
                    >
                        <Ionicons
                            name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
                            size={Platform.select({ ios: 28, default: 24 })}
                            color="#000"
                        />
                    </Pressable>
                )
            }
        </>
    )
}
