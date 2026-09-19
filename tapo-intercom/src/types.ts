export interface TapoConfig {
    host: string;
    /** Tapo's talk endpoint port. 8800 on every model seen. */
    port: number;
    /** The Tapo CLOUD account password. It is hashed and verified locally by the camera -- no
     * traffic leaves the LAN -- but the local "camera account" credentials are NOT accepted by
     * the talk endpoint, so this specific secret is unavoidable on these models. */
    cloudPassword: string;
    /** A previous cloud password, tried as a fallback: cameras pick up a password change at
     * their own pace, so a rotation otherwise breaks the ones that have not synced. */
    previousCloudPassword: string;
    /** Local camera-account credentials, used only by the self-test's RTSP listen-back. */
    rtspUsername: string;
    rtspPassword: string;
    /** RTSP path for the self-test. stream1 is the main stream, stream2 the sub. */
    rtspPath: string;
}
