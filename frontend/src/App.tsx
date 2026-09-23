import { RouterProvider } from 'react-router-dom'
import { router } from './router'
import { CameraFeedProvider } from './context/CameraFeedContext'
import './App.css'


function App() {
  return (
    <CameraFeedProvider>
      <RouterProvider router={router} />
    </CameraFeedProvider>
  )
}

export default App;
