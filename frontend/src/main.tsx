import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import { Home } from "./pages/Home";
import { RoomRoute } from "./pages/Room";
import { Join } from "./pages/Join";
import { ErrorPage } from "./pages/ErrorPage";

const router = createBrowserRouter([
  { path: "/", element: <Home />, errorElement: <ErrorPage /> },
  // The share link. Short and typeable, because people read it out loud.
  { path: "/r/:code", element: <Join />, errorElement: <ErrorPage /> },
  { path: "/room/:roomID", element: <RoomRoute />, errorElement: <ErrorPage /> },
  // Invite links handed out before room codes existed.
  { path: "/join/:token", element: <Join />, errorElement: <ErrorPage /> },
  { path: "*", element: <Home /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
