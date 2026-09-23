import { createBrowserRouter, RouteObject } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { AlertsPage } from './pages/AlertsPage';
import { PostIncidentReplay } from './pages/PostIncidentReplay';
import { Settings } from './pages/Settings';
import { LocalVideoPage } from './pages/LocalVideoPage';


export const routes: RouteObject[] = [
    {
        path: '/',
        element: <Dashboard />,
    },
    {
        path: '/alerts',
        element: <AlertsPage />
    },
    {
        path: '/replay',
        element: <PostIncidentReplay />
    },
    {
        path: '/settings',
        element: <Settings />
    },
    {
        path: '/local-video',
        element: <LocalVideoPage />
    },
];

export const router = createBrowserRouter(routes);