export interface FoscamConfig {
    host: string;
    /** Foscam web/media port. Both the CGI API and the low-level talk protocol live here. */
    port: number;
    username: string;
    password: string;
    /** RTSP path used only by the self-test, to listen to the camera while talking to it. */
    rtspPath: string;
}
