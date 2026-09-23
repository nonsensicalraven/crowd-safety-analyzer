import React from "react";
import { useNavigate } from "react-router-dom";
import { useCameraFeed } from "../context/CameraFeedContext";
//import { wrap } from "module";

const ZONE = "Zone";

export const LocalVideoPage: React.FC = () => {
    const navigate = useNavigate();
    const { fileName, setVideoFile, clearVideo } = useCameraFeed();

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setVideoFile(file);
        e.target.value = "";
    };

    return (
        <div style={{ padding: "20px", fontFamily: "sans-serif", backgroundColor: "#2b2b2c", minHeight: "100vh" }}>
            <button
                onClick={() => navigate("/")}
                style={{
                    marginBottom: "16px",
                    padding: "8px 12px",
                    backgroundColor: "#6b7280",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "14px",
                }}
            >
                Back to Dashboard
            </button>

            <h1 style={{ color: "#fff" }}>Local Video</h1>
            <p style={{ color: "#fff" }}>
                Select a local camera-feed video. Playback and heatmap overlay stay on the main dashboard.
            </p>

            <div
                style={{
                    margin: "24px auto 0",
                    border: "1px solid #ddd",
                    borderRadius: "8px",
                    width: "100%",
                    maxWidth: "690px",
                    minHeight: "320px",
                    backgroundColor: "#f9f9f9",
                    padding: "16px",
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                }}
            >
                <h3 style={{ margin: 0 }}>{ZONE}</h3>
                <p style={{ margin: "8px 0 16px 0", color: "#666", fontSize: "14px" }}>
                    {fileName ? `Selected: ${fileName}` : "No video selected"}
                </p>

                <label
                    htmlFor="zone-a-video-upload"
                    style={{
                        flex: "1 1 auto",
                        minHeight: "180px",
                        border: "2px dashed #bbb",
                        borderRadius: "8px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#666",
                        fontSize: "14px",
                        cursor: "pointer",
                        backgroundColor: "#fff",
                        textAlign: "center",
                        padding: "16px",
                    }}
                >
                    Click to select a local video file
                    <input
                        id="zone-a-video-upload"
                        type="file"
                        accept="video/*"
                        onChange={handleFileChange}
                        style={{ display: "none" }}
                    />
                </label>

                {fileName && (
                    <div style={{ marginTop: "16px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button
                            onClick={() => navigate("/")}
                            style={{
                                padding: "10px 14px",
                                backgroundColor: "#3b82f6",
                                color: "#fff",
                                border: "none",
                                borderRadius: "6px",
                                cursor: "pointer",
                                fontSize: "14px",
                                fontWeight: "bold",
                            }}
                        >
                            View on dashboard
                        </button>
                        <button
                            onClick={clearVideo}
                            style={{
                                padding: "10px 14px",
                                backgroundColor: "#6b7280",
                                color: "#fff",
                                border: "none",
                                borderRadius: "6px",
                                cursor: "pointer",
                                fontSize: "14px",
                                fontWeight: "bold",
                            }}
                        >
                            Clear selection
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
