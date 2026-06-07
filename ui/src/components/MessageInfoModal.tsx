import React from "react";
import { createPortal } from "react-dom";
import { Message } from "../types";
import { useEscapeClose } from "./useEscapeClose";

interface MessageInfoModalProps {
  message: Message;
  onClose: () => void;
}

// MessageInfoModal shows basic metadata for a message that has no token-usage
// data (e.g. user messages). It mirrors UsageDetailModal so the info action is
// available symmetrically across message types.
function MessageInfoModal({ message, onClose }: MessageInfoModalProps) {
  const formatTimestamp = (isoString: string): string => {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return isoString;
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  useEscapeClose(true, onClose);

  return createPortal(
    <div className="usage-detail-overlay" onClick={onClose}>
      <div className="usage-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="usage-detail-header">
          <h2 className="usage-detail-title">Message Details</h2>
          <button onClick={onClose} className="usage-detail-close-button" aria-label="Close">
            ×
          </button>
        </div>
        <div className="usage-detail-grid">
          <div className="usage-detail-label">Type:</div>
          <div className="usage-detail-value">{message.type}</div>
          {message.created_at && (
            <>
              <div className="usage-detail-label">Timestamp:</div>
              <div className="usage-detail-value">{formatTimestamp(message.created_at)}</div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default MessageInfoModal;
