import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface CameraFeedContextValue {
    videoSrc: string | null;
    fileName: string | null;
    setVideoFile: (file: File) => void;
    clearVideo: () => void;
}

const CameraFeedContext = createContext<CameraFeedContextValue | null>(null);

export const CameraFeedProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const videoSrcRef = useRef<string | null>(null);

    const clearVideo = useCallback(() => {
        if (videoSrcRef.current) {
            URL.revokeObjectURL(videoSrcRef.current);
            videoSrcRef.current = null;
        }
        setVideoSrc(null);
        setFileName(null);
    }, []);

    const setVideoFile = useCallback((file: File) => {
        const url = URL.createObjectURL(file);
        if (videoSrcRef.current) {
            URL.revokeObjectURL(videoSrcRef.current);
        }
        videoSrcRef.current = url;
        setVideoSrc(url);
        setFileName(file.name);
    }, []);

    useEffect(() => {
        return () => {
            if (videoSrcRef.current) {
                URL.revokeObjectURL(videoSrcRef.current);
            }
        };
    }, []);

    return (
        <CameraFeedContext.Provider value={{ videoSrc, fileName, setVideoFile, clearVideo }}>
            {children}
        </CameraFeedContext.Provider>
    );
};

export function useCameraFeed(): CameraFeedContextValue {
    const ctx = useContext(CameraFeedContext);
    if (!ctx) {
        throw new Error("useCameraFeed must be used within CameraFeedProvider");
    }
    return ctx;
}
