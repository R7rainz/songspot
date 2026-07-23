import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import { Home } from "./pages/Home";
import { Room } from "./pages/Room";
import { Join } from "./pages/Join";

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/room/:roomID", element: <Room /> },
  { path: "/join/:token", element: <Join /> },
  { path: "*", element: <Home /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
