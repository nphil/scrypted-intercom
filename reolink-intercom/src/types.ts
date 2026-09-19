export interface ReolinkConfig {
    host: string;
    /** Baichuan port. 9000 on every model seen; `cmd=GetPortInfo` does not report it. */
    port: number;
    username: string;
    password: string;
    /** Baichuan channel. 0 for a standalone camera; an NVR channel otherwise. */
    channel: number;
    /** RTSP path used only by the self-test, to listen to the camera while talking to it. */
    rtspPath: string;
}
